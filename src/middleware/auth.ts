import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifySupabaseToken, type SupabaseTokenPayload } from '../lib/supabase-jwt.js';

/**
 * Hono context augmentation — anything we set with c.set(key, value) is
 * available via c.get(key) downstream and gets full TS autocomplete.
 */
export interface AuthVariables {
  user: {
    id: string;
    email: string | undefined;
    raw: SupabaseTokenPayload;
  };
}

const extractBearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
};

/**
 * Requires a valid Supabase JWT in `Authorization: Bearer <token>`.
 * On success, attaches the user to c.var.user.
 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const token = extractBearer(c.req.header('authorization'));
  if (!token) {
    throw new HTTPException(401, { message: 'Missing or malformed Authorization header' });
  }

  let payload: SupabaseTokenPayload;
  try {
    payload = await verifySupabaseToken(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed';
    const code = (err as { code?: string })?.code;
    // Log with full detail so dev can see why JWT verify failed; client gets a
    // generic-ish message but with the jose error code which is very diagnostic.
    console.error('[auth] JWT verification failed:', { code, message });
    throw new HTTPException(401, {
      message: code ? `${message} (${code})` : message,
    });
  }

  c.set('user', {
    id: payload.sub,
    email: payload.email,
    raw: payload,
  });

  await next();
};
