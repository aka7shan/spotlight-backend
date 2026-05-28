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
