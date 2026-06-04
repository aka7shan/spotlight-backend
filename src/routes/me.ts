import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { rateLimitByUser } from '../middleware/rate-limit.js';
import { UpdateMeSchema } from '../schemas/profile.js';
import {
  ensureProfile,
  getAssembledUser,
  ProfileNotFoundError,
  saveAssembledUser,
} from '../services/profile.js';
import {
  ALLOWED_AVATAR_MIME_TYPES,
  MAX_AVATAR_BYTES,
  StorageError,
  deleteAvatar,
  uploadAvatar,
} from '../lib/storage.js';
import { getDb } from '../lib/db.js';
import { profiles } from '../db/schema.js';

/**
 * /v1/me — operations on the currently authenticated user's profile.
 *
 * Rate-limit policy
 * -----------------
 *  GET /v1/me  — 120 req/min/user. The frontend fetches this exactly once
 *                per session today, so the only legitimate way to hit this
 *                ceiling is a misbehaving client (retry storm, useEffect
 *                in a loop). We still want the ceiling — that's what
 *                catches the broken client before it floods our logs.
 *
 *  PUT /v1/me  — 20 req/min/user. The save button is debounced in the UI
 *                and a real user can't legitimately save 20+ times per
 *                minute. This protects the DB transaction (delete + bulk
 *                insert across 7 child tables) from being hammered.
 */
export const meRoutes = new Hono<{ Variables: AuthVariables }>();

meRoutes.use('*', requireAuth);

const readLimiter = rateLimitByUser({
  scope: 'me.read',
  limit: 120,
  windowMs: 60_000,
});

const writeLimiter = rateLimitByUser({
  scope: 'me.write',
  limit: 20,
  windowMs: 60_000,
});

// Avatar uploads are heavier (file I/O + Storage round-trip) so we want a
// tighter limit than the regular write path. 10/min easily handles a user
// who's iterating on their avatar choice; anything faster than that is a
// loop or an attack.
const avatarLimiter = rateLimitByUser({
  scope: 'me.avatar',
  limit: 10,
  windowMs: 60_000,
});

/**
 * Pull email/name out of the verified JWT so we can self-heal a missing
 * `profiles` row. Supabase's signup trigger _usually_ creates this row,
 * but devs delete rows manually, triggers can be disabled, etc.
 */
const authProfileBootstrap = (c: { var: AuthVariables }) => ({
  userId: c.var.user.id,
  email: c.var.user.email ?? '',
  name: (c.var.user.raw.user_metadata?.name as string | undefined) ?? '',
});

meRoutes.get('/', readLimiter, async (c) => {
  // Phase-level timing so we can see in Vercel logs which step is slow when
  // a user reports lag. Log line shape:
  //   [me.get] ensure=12ms assemble=180ms total=193ms userId=...
  // Use process.hrtime.bigint() to avoid Date.now()'s 1ms granularity quirks
  // on Node's monotonic-but-rounded clock.
  const t0 = process.hrtime.bigint();

  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);
  const tEnsure = process.hrtime.bigint();

  const user = await getAssembledUser(bootstrap.userId);
  if (!user) {
    // ensureProfile didn't throw but the row still isn't visible — should be
    // impossible, but fail loudly if it happens.
    throw new HTTPException(500, { message: 'Profile creation failed' });
  }
  const tAssemble = process.hrtime.bigint();

  const ms = (a: bigint, b: bigint) => Number((b - a) / 1_000_000n);
  console.log(
    `[me.get] ensure=${ms(t0, tEnsure)}ms assemble=${ms(
      tEnsure,
      tAssemble,
    )}ms total=${ms(t0, tAssemble)}ms userId=${bootstrap.userId}`,
  );

  return c.json({ user });
});

meRoutes.put(
  '/',
  writeLimiter,
  zValidator('json', UpdateMeSchema, (result, c) => {
    if (!result.success) {
      // Log full diagnostic server-side. The client only sees a sanitized
      // "field => message" pair so we don't leak internal field names that
      // future schema changes might rename.
      console.error(
        '[validator] PUT /v1/me failed:\n' +
          z.prettifyError(result.error),
      );
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
  const input = c.req.valid('json');

  try {
    await saveAssembledUser(bootstrap.userId, input);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      throw new HTTPException(404, { message: 'Profile not found' });
    }
    throw err;
  }

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user });
});

// ---------------------------------------------------------------------------
// Avatar (Phase 1.0 — Supabase Storage)
// ---------------------------------------------------------------------------
//
// POST   /v1/me/avatar — multipart upload, replaces existing avatar
// DELETE /v1/me/avatar — removes avatar from Storage AND clears DB field
//
// We don't expose a GET because the avatar URL is already part of the
// assembled User returned by GET /v1/me. Frontend just consumes that.
//
// Why a dedicated endpoint instead of overloading PUT /v1/me?
//  - File uploads need multipart/form-data, not JSON
//  - Atomic semantics: upload + DB update happen together or not at all
//  - Tighter rate limit (avatar uploads are heavy; profile saves are cheap)
//  - Lets the frontend show real upload progress without coupling to a
//    full profile-save round-trip
// ---------------------------------------------------------------------------

meRoutes.post('/avatar', avatarLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  // parseBody() returns the whole multipart payload. We only care about
  // the "file" field. Hono types this as string | File | (string|File)[].
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch (err) {
    console.error('[me.avatar] failed to parse multipart body', err);
    throw new HTTPException(400, { message: 'Invalid multipart body' });
  }

  const raw = body.file;
  const file = Array.isArray(raw) ? raw[0] : raw;
  if (!file || typeof file === 'string') {
    throw new HTTPException(400, {
      message: 'Missing "file" field in multipart body',
    });
  }

  // Fast pre-checks before we read the bytes into memory. The Storage helper
  // re-validates after upload but rejecting here keeps the function memory
  // footprint smaller for obvious oversized requests.
  if (file.size > MAX_AVATAR_BYTES) {
    throw new HTTPException(413, {
      message: `Avatar exceeds ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB limit.`,
    });
  }
  if (!ALLOWED_AVATAR_MIME_TYPES.includes(file.type)) {
    throw new HTTPException(415, {
      message: `Unsupported avatar type "${file.type}". Allowed: ${ALLOWED_AVATAR_MIME_TYPES.join(', ')}.`,
    });
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  let publicUrl: string;
  try {
    publicUrl = await uploadAvatar(bootstrap.userId, buffer, file.type);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 413 | 415 | 500, { message: err.message });
    }
    throw err;
  }

  // Update profile.avatar_url. We deliberately do NOT touch the dedicated
  // PUT /v1/me update path here — that endpoint has unsaved-changes
  // semantics on the frontend, and we don't want the avatar upload to
  // accidentally flush a half-edited form.
  await getDb()
    .update(profiles)
    .set({ avatarUrl: publicUrl, updatedAt: new Date() })
    .where(eq(profiles.userId, bootstrap.userId));

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user, avatarUrl: publicUrl });
});

meRoutes.delete('/avatar', avatarLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  try {
    await deleteAvatar(bootstrap.userId);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 500, { message: err.message });
    }
    throw err;
  }

  await getDb()
    .update(profiles)
    .set({ avatarUrl: null, updatedAt: new Date() })
    .where(eq(profiles.userId, bootstrap.userId));

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user });
});
