import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { requireSupabaseAuth } from '../env.js';

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
  const sup = requireSupabaseAuth();

  // Peek at the (unverified) token so we can:
  //   1. Pick the right verifier based on the `alg` header (no wasted HS256
  //      attempt on JWKS-only projects).
  //   2. Give actionable error messages when verification later fails.
  let unverified: JWTPayload | null = null;
  let alg: string | undefined;
  try {
    unverified = decodeJwt(token);
    alg = decodeProtectedHeader(token).alg;
  } catch {
    // We'll let jwtVerify throw the real error below.
  }

  // Strict signature verification, soft claim checks. The Supabase issuer
  // claim has changed between project generations (`https://<ref>.supabase.co/auth/v1`
  // for older projects, `supabase` for some others); locking it down here
  // causes more outages than it prevents. RLS + audience keep us safe.
  const commonOptions = {
    audience: 'authenticated',
  } as const;

  // Prefer the path indicated by the token's own `alg` header so we don't
  // burn a verify attempt that's guaranteed to fail. Fall back to "try both"
  // if we couldn't decode the header (malformed token — let jose tell us).
  const tryHS256 = sup.jwtSecret && (alg === 'HS256' || alg == null);
  const tryJWKS = alg !== 'HS256' || !sup.jwtSecret;

  if (tryHS256 && sup.jwtSecret) {
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
      // Only fall through to JWKS for errors that suggest "wrong key" —
      // signature mismatch or unexpected alg. Anything else (expired,
      // audience mismatch, malformed) is terminal and we re-throw.
      const recoverable =
        code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
        code === 'ERR_JOSE_ALG_NOT_ALLOWED';
      if (!recoverable || !tryJWKS) throw err;
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
        alg,
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
