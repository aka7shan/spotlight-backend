import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { requireSupabase } from '../env.js';

/**
 * Supabase-issued JWT verification.
 *
 * Supabase has two signing modes:
 *
 *  1. **HS256 + shared secret** (legacy + the default for most free-tier projects).
 *     The secret is the value at Dashboard -> Project Settings -> API -> "JWT Secret".
 *     If `SUPABASE_JWT_SECRET` is set, we use this — fastest, no network calls.
 *
 *  2. **Asymmetric keys** (newer "JWT Signing Keys" feature).
 *     We fetch the project's public keys from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
 *
 * Strategy: if the shared secret is configured, try HS256 first. If verification
 * fails (e.g. the project actually migrated to asymmetric keys), fall back to
 * JWKS. If no secret is configured, go straight to JWKS.
 */

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(url: string) {
  if (jwks) return jwks;
  jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return jwks;
}

export interface SupabaseTokenPayload extends JWTPayload {
  sub: string; // Supabase user id (uuid)
  email?: string;
  role?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export async function verifySupabaseToken(token: string): Promise<SupabaseTokenPayload> {
  const sup = requireSupabase();

  // Peek at the (unverified) token so we can give actionable error messages
  // when the signature/claims later don't match what we expect.
  let unverified: JWTPayload | null = null;
  try {
    unverified = decodeJwt(token);
  } catch {
    // We'll let jwtVerify throw the real error below.
  }

  // We verify SIGNATURE strictly, but only soft-check claims like `iss`. The
  // Supabase issuer claim has changed between project generations
  // (`https://<ref>.supabase.co/auth/v1` for older projects, `supabase` for
  // some others) so locking it down here causes more outages than it prevents.
  // RLS + audience checks still keep us safe.
  const commonOptions = {
    audience: 'authenticated',
  } as const;

  // HS256 (shared secret) — default for legacy projects without JWT Signing Keys
  if (sup.jwtSecret) {
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(sup.jwtSecret),
        commonOptions,
      );
      if (!payload.sub) throw new Error('Token is missing a subject claim');
      return payload as SupabaseTokenPayload;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const recoverable =
        code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
        code === 'ERR_JOSE_ALG_NOT_ALLOWED';
      if (!recoverable) throw err;
    }
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(sup.url), commonOptions);
    if (!payload.sub) throw new Error('Token is missing a subject claim');
    return payload as SupabaseTokenPayload;
  } catch (err) {
    // Decorate the error with the decoded (unverified) claims so the dev log
    // shows exactly what we received vs. what we expected. Don't leak this to
    // the client — the middleware logs server-side.
    const code = (err as { code?: string })?.code;
    if (unverified) {
      console.error('[jwt] verify failed', {
        code,
        alg: (unverified as { header?: { alg?: string } }).header?.alg,
        iss: unverified.iss,
        aud: unverified.aud,
        sub: unverified.sub,
        exp: unverified.exp,
        now: Math.floor(Date.now() / 1000),
      });
    }
    throw err;
  }
}
