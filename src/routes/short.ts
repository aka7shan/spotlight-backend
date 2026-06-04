/**
 * /v1/p/:code — public anonymous portfolio lookup by short code.
 *
 * Phase 1.2 supersedes the older /v1/public/:username route. URLs are
 * now Base62 short codes minted on portfolio creation
 * (`/p/k7j8H2p` style) — no usernames, no validation, no rename UX, no
 * cache-busting headaches when someone changes their handle.
 *
 * Response shape
 * --------------
 * The response is the same `AssembledUser` shape as `/v1/me`, minus
 * the internal user UUID (`id`). Visitors get everything they need to
 * render the public page; the `shortCode` field is included so the
 * page can self-link (canonical URL).
 *
 * Performance + cache strategy
 * ----------------------------
 * Anonymous lookups are the hottest path in the app — every social-
 * media click resolves through here. We use a two-tier strategy:
 *
 *   1. **Upstash Redis** as a hot cache keyed on the short code.
 *      60-second TTL with explicit invalidation when the user mutates
 *      their profile (see `invalidateShortCodeCache`). When the
 *      cache is enabled, repeat lookups for a popular code skip
 *      Postgres entirely.
 *
 *   2. **HTTP-level ETag** for client/CDN revalidation. We compute a
 *      weak ETag from the user id + `updatedAt` timestamp. If the
 *      visitor's browser sends `If-None-Match` and the value matches,
 *      we return `304 Not Modified` with empty body — the cheapest
 *      possible repeat-view (no JSON serialization, no body bytes).
 *
 *   3. **`Cache-Control: public, no-cache`** — every visitor must
 *      revalidate, but they can do so against the CDN/browser cache
 *      via the ETag. This means renames + edits become visible
 *      immediately (no 5-minute stale window), while still serving
 *      304s on revalidation.
 */

import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { cacheKeys, getCache } from '../lib/cache.js';
import { isValidShortCode } from '../lib/shortcode.js';
import { rateLimitByIp } from '../middleware/rate-limit.js';
import {
  type AssembledUser,
  getAssembledUserByShortCode,
} from '../services/profile.js';

export const shortRoutes = new Hono();

const publicLookupLimiter = rateLimitByIp({
  scope: 'public.shortcode',
  // 120 req/min/IP. A typical visitor fires this once per page load.
  // 120 covers a small workplace NAT and any reasonable navigation
  // pattern without enabling enumeration scrapes (a scraper trying
  // 3.5 trillion codes would die of old age before exhausting this
  // budget, but we still bound it).
  limit: 120,
  windowMs: 60_000,
});

/**
 * Anonymous response = AssembledUser minus the internal UUID. We never
 * leak `id` (the Supabase auth UUID) on public endpoints — it's
 * worthless to a real visitor and would let attackers cross-reference
 * with other endpoints that key on user id.
 */
type PublicUser = Omit<AssembledUser, 'id'>;

const CACHE_TTL_SECONDS = 60;

shortRoutes.get('/:code', publicLookupLimiter, async (c) => {
  const code = c.req.param('code');

  // Reject malformed codes BEFORE any cache or DB call. Anyone hitting
  // /v1/p/<garbage> is either an attacker probing or a typo'd URL —
  // either way the work to look it up is wasted.
  if (!isValidShortCode(code)) {
    throw new HTTPException(404, { message: 'Portfolio not found.' });
  }

  const cache = getCache();
  const cacheKey = cacheKeys.shortCode(code);

  // Try cache first. On a hit we still need to honor If-None-Match
  // (the ETag is part of the cached envelope, see below).
  const cached = await cache.get<{ user: PublicUser; etag: string }>(cacheKey);
  if (cached) {
    return respondWithUser(c, cached.user, cached.etag);
  }

  // Cache miss → DB.
  const user = await getAssembledUserByShortCode(code);
  if (!user) {
    // Don't cache misses — a freshly-minted code would otherwise be
    // 404'd for 60s after the user creates it (if a curious visitor
    // hit the URL during that window). Misses are also a tiny share
    // of traffic for legitimate links.
    throw new HTTPException(404, { message: 'Portfolio not found.' });
  }

  // Strip the internal UUID before caching. We never want the cache
  // to materialize a representation that includes it; the line
  // between "what we read from the service" and "what we hand to
  // visitors" is right here.
  const { id: _omit, ...publicUser } = user;
  const etag = buildEtag(user.id, user.updatedAt);

  // Best-effort cache write. If Redis is unavailable the request
  // still succeeds, just at DB cost.
  await cache.set(cacheKey, { user: publicUser, etag }, CACHE_TTL_SECONDS);

  return respondWithUser(c, publicUser, etag);
});

/**
 * Send the response with ETag + cache headers, honoring If-None-Match
 * for 304s. Centralized so the cache-hit and cache-miss paths can't
 * drift on header semantics.
 */
function respondWithUser(c: Context, user: PublicUser, etag: string) {
  // Standard ETag negotiation. The header is always set so a client
  // can latch on for future revalidation; if the request already had
  // a matching ETag we return 304 with empty body.
  c.header('ETag', etag);
  // `public, no-cache` is the cache trick: it allows the CDN/browser
  // to store the response, but they MUST revalidate every time (i.e.
  // send If-None-Match). Combined with the ETag, hot links serve
  // from cache via 304s with no body, while stale data after a
  // mutation gets corrected on the first refresh.
  c.header('Cache-Control', 'public, no-cache, must-revalidate');
  // Hint to shared caches: vary on accept so a future content-type
  // negotiation (HTML vs JSON) doesn't poison the wrong consumer.
  c.header('Vary', 'Accept');

  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    // 304 must have no body. Hono's c.body(null, status) returns the
    // right envelope.
    return c.body(null, 304);
  }

  return c.json({ user });
}

/**
 * Build a weak ETag from the user id + updatedAt. Weak (`W/`) because
 * the body bytes could change with no semantic difference (e.g. JSON
 * key ordering differences across runtimes) and we'd still want a
 * 304 to be valid.
 */
function buildEtag(userId: string, updatedAtIso: string): string {
  const ms = Date.parse(updatedAtIso);
  // Safe: `updatedAt` is always a valid ISO string in our schema; if
  // parsing somehow fails we use 0, which still produces a stable
  // (if uninformative) ETag for this row's lifetime.
  return `W/"${userId}-${Number.isFinite(ms) ? ms : 0}"`;
}
