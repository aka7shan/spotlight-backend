import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { rateLimitByUser } from '../middleware/rate-limit.js';
import {
  CheckUsernameQuerySchema,
  UpdateUsernameSchema,
} from '../schemas/profile.js';
import { validateUsername, generateRandomUsername } from '../lib/slug.js';
import {
  checkUsernameAvailability,
  ensureProfile,
  getAssembledUser,
  ProfileNotFoundError,
  UsernameTakenError,
  updateUsername,
} from '../services/profile.js';

/**
 * /v1/me/share — manage the current user's public URL (Phase 1.1).
 *
 * Endpoints
 * ---------
 *  PATCH /v1/me/share        rename username
 *  GET   /v1/me/share/check  availability probe (autocomplete in the UI)
 *  GET   /v1/me/share/suggest produce a random valid username
 *
 * Design note
 * -----------
 *  We deliberately do NOT split "publish" and "edit slug" into two endpoints.
 *  Phase 1.1 has no soft-private mode — every signed-up user has a public
 *  URL at /spotlight/<username> by default. The only thing the user
 *  controls here is what that <username> string is.
 */

export const shareRoutes = new Hono<{ Variables: AuthVariables }>();
shareRoutes.use('*', requireAuth);

const renameLimiter = rateLimitByUser({
  scope: 'share.rename',
  // 5 renames/min/user is generous for a real user (one bad UI loop = 5
  // failed attempts) but cheap for the autocomplete to retry.
  limit: 5,
  windowMs: 60_000,
});

const checkLimiter = rateLimitByUser({
  scope: 'share.check',
  // Typing into the "claim username" box could fire 1 check/keystroke.
  // 60/min/user = one per second sustained, which the frontend already
  // debounces below.
  limit: 60,
  windowMs: 60_000,
});

const authProfileBootstrap = (c: { var: AuthVariables }) => ({
  userId: c.var.user.id,
  email: c.var.user.email ?? '',
  name: (c.var.user.raw.user_metadata?.name as string | undefined) ?? '',
});

// ---------------------------------------------------------------------------
// PATCH /v1/me/share — rename
// ---------------------------------------------------------------------------

shareRoutes.patch(
  '/',
  renameLimiter,
  zValidator('json', UpdateUsernameSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 422,
            message: 'Validation failed',
            details: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
        422,
      );
    }
  }),
  async (c) => {
    const bootstrap = authProfileBootstrap(c);
    if (!bootstrap.email) {
      throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
    }
    await ensureProfile(bootstrap);

    const { username } = c.req.valid('json');

    // Apply the same rules the DB does, plus our reserved-word list. We
    // return a 400 with a structured `code` so the frontend can map to
    // inline field validation instead of a toast.
    const validationError = validateUsername(username);
    if (validationError) {
      return c.json(
        {
          error: {
            code: 400,
            message: validationError.message,
            // The specific failure code (too_short, reserved, etc.) — stable
            // across releases so the frontend can branch on it.
            kind: validationError.code,
          },
        },
        400,
      );
    }

    try {
      const result = await updateUsername(bootstrap.userId, username);
      const user = await getAssembledUser(bootstrap.userId);
      return c.json({ user, username: result.username });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        return c.json(
          {
            error: {
              code: 409,
              message: `Username "${err.username}" is already taken.`,
              kind: 'taken',
            },
          },
          409,
        );
      }
      if (err instanceof ProfileNotFoundError) {
        throw new HTTPException(404, { message: 'Profile not found' });
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/me/share/check?username=foo — availability
// ---------------------------------------------------------------------------

shareRoutes.get(
  '/check',
  checkLimiter,
  zValidator('query', CheckUsernameQuerySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: { code: 422, message: 'Missing or invalid `username` query param.' },
        },
        422,
      );
    }
  }),
  async (c) => {
    const bootstrap = authProfileBootstrap(c);
    const { username } = c.req.valid('query');

    // Validate format BEFORE the DB round-trip so we don't waste a query on
    // garbage input. Returns the same `kind` codes as PATCH so frontend
    // logic stays uniform.
    const validationError = validateUsername(username);
    if (validationError) {
      return c.json({
        available: false,
        kind: validationError.code,
        message: validationError.message,
      });
    }

    const status = await checkUsernameAvailability(username, bootstrap.userId);
    return c.json({
      available: status !== 'taken',
      kind: status,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /v1/me/share/suggest — randomly-generated valid username
// ---------------------------------------------------------------------------
//
// Returns a candidate that's currently free. We try a few times in case of
// (extremely unlikely) collisions; bail with a 503 if we somehow can't find
// one. Useful for the "I don't care, just give me a URL" flow on the share UI.

shareRoutes.get('/suggest', checkLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);

  for (let i = 0; i < 5; i++) {
    const candidate = generateRandomUsername(8);
    // Sanity-check format (should always pass for base62 8-char output).
    if (validateUsername(candidate) !== null) continue;
    const status = await checkUsernameAvailability(candidate, bootstrap.userId);
    if (status === 'available') {
      return c.json({ username: candidate });
    }
  }
  throw new HTTPException(503, {
    message: 'Could not find an available random username after 5 tries. Please try again.',
  });
});
