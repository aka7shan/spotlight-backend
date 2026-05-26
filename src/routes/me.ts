import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { UpdateMeSchema } from '../schemas/profile.js';
import {
  ensureProfile,
  getAssembledUser,
  ProfileNotFoundError,
  saveAssembledUser,
} from '../services/profile.js';

/**
 * /v1/me — operations on the currently authenticated user's profile.
 */
export const meRoutes = new Hono<{ Variables: AuthVariables }>();

meRoutes.use('*', requireAuth);

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

meRoutes.get('/', async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);
  const user = await getAssembledUser(bootstrap.userId);
  if (!user) {
    // ensureProfile didn't throw but the row still isn't visible — should be
    // impossible, but fail loudly if it happens.
    throw new HTTPException(500, { message: 'Profile creation failed' });
  }
  return c.json({ user });
});

meRoutes.put(
  '/',
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
