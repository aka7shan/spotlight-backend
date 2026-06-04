import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { rateLimitByIp } from '../middleware/rate-limit.js';
import { isValidUsername } from '../lib/slug.js';
import { getAssembledUserByUsername } from '../services/profile.js';

/**
 * /v1/public/:username — anonymous portfolio lookup (Phase 1.1).
 *
 * Powers the /spotlight/<username> page on the frontend. No auth required.
 *
 * Privacy posture
 * ---------------
 *  We return the FULL assembled user document — name, contact info, social
 *  links, etc. — because that's the point of a public portfolio. If a user
 *  doesn't want a piece of info visible, they shouldn't put it in their
 *  profile. (Future: per-field visibility toggles when Phase 1.x adds a
 *  "private mode".)
 *
 *  We do NOT return:
 *    - the user's auth UUID (`id`) — replaced with the username, which is
 *      already public knowledge
 *    - any timestamps or schema-internal metadata that don't help a visitor
 *
 * Rate limiting
 * -------------
 *  Per-IP. 60 req/min/IP is plenty for a real visitor (a page render fires
 *  this once), but holds back a script trying to scrape every public
 *  profile. A real scraper will rotate IPs and bypass this — in-memory
 *  limits behind a serverless platform are not a robust defense — but it's
 *  what we've got until Phase 2 puts Upstash in front of it.
 */

export const publicRoutes = new Hono();

const publicLimiter = rateLimitByIp({
  scope: 'public.read',
  limit: 60,
  windowMs: 60_000,
});

publicRoutes.get('/:username', publicLimiter, async (c) => {
  const username = c.req.param('username');

  // Reject malformed usernames BEFORE the DB round-trip. Anyone hitting
  // /v1/public/<garbage> is either an attacker probing or a typo'd URL —
  // either way we don't need to incur a query for them. Also gives us a
  // chance to short-circuit obvious "Big List" enumeration attempts.
  if (!username || !isValidUsername(username)) {
    throw new HTTPException(404, { message: 'Profile not found.' });
  }

  const user = await getAssembledUserByUsername(username);
  if (!user) {
    throw new HTTPException(404, { message: 'Profile not found.' });
  }

  // Strip the internal user UUID — visitors don't need it and exposing it
  // would let them probe other endpoints. The `username` field already
  // identifies the row.
  const { id: _omit, ...publicUser } = user;

  // Public cache hints. Vercel/CDN will hold a copy for `s-maxage` seconds
  // and the browser for `max-age`. We use moderate values: long enough to
  // cushion traffic spikes, short enough that "update profile" → "refresh
  // public URL" feels alive.
  c.header('Cache-Control', 'public, max-age=60, s-maxage=300');

  return c.json({ user: publicUser });
});
