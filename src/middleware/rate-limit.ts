import type { MiddlewareHandler, Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * In-memory fixed-window rate limiter.
 *
 * Why in-memory instead of Redis/Upstash?
 * ---------------------------------------
 *  - No new external dependency or env var for Phase 0.
 *  - Vercel cold-starts often, so on serverless this enforces "per-instance"
 *    limits, not truly global ones. It's best-effort defense against runaway
 *    loops and obvious abuse, NOT a hard guarantee at scale.
 *  - Phase 1 will swap the store for Upstash Ratelimit when we add Redis.
 *
 * Memory bookkeeping
 * ------------------
 *  We cap the bucket map at MAX_BUCKETS entries and evict the oldest on
 *  insert. Each Vercel function instance lives O(minutes) so this prevents
 *  unbounded growth if the keyspace explodes from an attack.
 *
 * Standard response headers
 * -------------------------
 *  Every response carries `X-RateLimit-Limit` / `X-RateLimit-Remaining` /
 *  `X-RateLimit-Reset`. Limited responses also carry `Retry-After`. We
 *  follow the common (non-standardized) Stripe/GitHub naming.
 */

interface BucketState {
  windowStartMs: number;
  count: number;
}

interface RateLimitOptions {
  /** Maximum requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Per-request key. Default: client IP. Pass user-aware keys for /v1/me. */
  keyResolver?: (c: Context) => string;
  /** Optional human-readable label appended to the 429 message and key namespace. */
  scope?: string;
}

const MAX_BUCKETS = 10_000;
const buckets = new Map<string, BucketState>();

function defaultKey(c: Context): string {
  // Best-effort client IP. Vercel sets x-forwarded-for; otherwise we get
  // the raw connection address (often the platform's edge, not the user).
  // For unauthenticated paths this is the cheapest available signal.
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const xri = c.req.header('x-real-ip');
  if (xri) return xri.trim();
  return 'anon';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, keyResolver = defaultKey, scope = 'global' } = opts;

  return async (c, next) => {
    const rawKey = keyResolver(c);
    const key = `${scope}:${rawKey}`;
    const now = Date.now();

    let state = buckets.get(key);
    if (!state || now - state.windowStartMs >= windowMs) {
      // Window expired (or first hit). Reset.
      state = { windowStartMs: now, count: 0 };
      // Opportunistic eviction. Map insertion order is preserved in JS, so
      // the first key is the oldest. This is O(1) amortized; we accept the
      // (very small) chance of evicting a still-active bucket under heavy
      // unique-key churn.
      if (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      buckets.set(key, state);
    }

    state.count++;

    const remaining = Math.max(0, limit - state.count);
    const resetSec = Math.ceil((state.windowStartMs + windowMs - now) / 1000);

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(resetSec));

    if (state.count > limit) {
      c.header('Retry-After', String(resetSec));
      throw new HTTPException(429, {
        message: `Too many requests (${scope}). Try again in ${resetSec}s.`,
      });
    }

    await next();
  };
}

/**
 * Convenience: rate-limit by the authenticated user's id. Requires the
 * `requireAuth` middleware to have run first (so c.var.user is set).
 */
export function rateLimitByUser(
  opts: Omit<RateLimitOptions, 'keyResolver'> & { scope: string },
): MiddlewareHandler {
  return rateLimit({
    ...opts,
    keyResolver: (c) => {
      // `c.var.user` is set by requireAuth. If it isn't, we fall back to the
      // IP so the limiter still does something useful instead of throwing
      // on an undefined access.
      const user = (c as unknown as { var: { user?: { id: string } } }).var.user;
      return user?.id ?? defaultKey(c);
    },
  });
}
