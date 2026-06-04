/**
 * Base62 short-code generator for public portfolio URLs.
 *
 * Background
 * ----------
 * Phase 1.2 replaced the username-based public URL scheme
 * (`/spotlight/<username>`) with a Base62 short code
 * (`/p/<short_code>`) per portfolio. Goals:
 *
 *   - **Short to share.** 7 chars => 62^7 ≈ 3.52 trillion addresses.
 *     Even with the birthday paradox we can mint ~hundreds of millions
 *     of codes before collisions become a practical concern.
 *   - **Unpredictable.** Random source is `crypto.randomBytes`, not
 *     `Math.random()` or a monotonically-increasing sequence. Knowing
 *     one user's code reveals nothing about another's.
 *   - **URL-safe.** Base62 dodges +/= padding (vs Base64) and the
 *     potential lowercase/uppercase confusion of Base32 (we keep both
 *     cases distinct for entropy).
 *   - **Reserved-set-aware.** We exclude codes that match common
 *     frontend route segments (`profile`, `templates`, etc.) so that
 *     the public route `/p/<code>` never accidentally shadows or is
 *     shadowed by an app route. The `/p/` prefix already prevents
 *     collision with top-level app routes; the reserved check is a
 *     belt-and-suspenders measure for the future, when we may consider
 *     dropping the prefix.
 *
 * Why not nanoid / shortid / uuid-base62?
 * ---------------------------------------
 * Adding a dependency for ~40 lines of code we'll never need to touch
 * isn't worth it. `crypto.randomBytes` is in the Node stdlib, the
 * alphabet table is fixed, and the rejection-sampling loop fits on a
 * postcard.
 */

import { randomBytes } from 'node:crypto';

// 62 chars: 0-9 a-z A-Z. Order doesn't matter for correctness but we
// keep it in canonical Base62 order so codes are recognizable in logs.
export const BASE62_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Fixed code length. 7 chars in Base62 = 62^7 ≈ 3.52 × 10^12 addresses,
 * which is wildly more than this app will ever use. We can grow this if
 * we ever hit collision pressure (changing the constant doesn't break
 * existing codes — old codes are still valid as long as the lookup
 * works on the literal string).
 */
export const SHORT_CODE_LENGTH = 7;

/**
 * Codes that must never be issued because they'd shadow (or be shadowed
 * by) app routes if we ever drop the `/p/` URL prefix. Kept lowercase;
 * the validity check is case-insensitive against this set.
 *
 * Update this list when adding new top-level frontend routes.
 */
const RESERVED_CODES = new Set<string>([
  'profile',
  'profiles',
  'templates',
  'template',
  'portfolio',
  'portfolios',
  'auth',
  'login',
  'signup',
  'logout',
  'callback',
  'admin',
  'api',
  'jobs',
  'network',
  'messages',
  'profession',
  'settings',
  'about',
  'help',
  'support',
  'pricing',
  'terms',
  'privacy',
  'home',
  'index',
  'spotlight',
]);

/**
 * Format check: exactly SHORT_CODE_LENGTH Base62 chars. Used by the
 * route handler to reject malformed lookups before hitting the DB.
 *
 * We DON'T reject reserved codes here — those are only excluded at
 * generation time. If a reserved word somehow leaked into the DB
 * (legacy data, manual insert) the lookup should still work.
 */
const FORMAT_RE = new RegExp(`^[0-9a-zA-Z]{${SHORT_CODE_LENGTH}}$`);

export function isValidShortCode(value: unknown): value is string {
  return typeof value === 'string' && FORMAT_RE.test(value);
}

/**
 * Generate one random Base62 short code.
 *
 * Implementation notes
 * --------------------
 * - We use rejection sampling so the resulting distribution is uniform
 *   across the 62-char alphabet. The naive `byte % 62` would bias
 *   slightly toward the first 8 chars because 256 % 62 != 0. To stay
 *   uniform we draw bytes from a "safe zone" (the largest multiple of
 *   62 ≤ 256, i.e. 248) and discard everything ≥ 248. Worst case we
 *   loop a few extra times but the math stays clean.
 *
 * - We pull 32 bytes at a time (way more than the 7 we usually need)
 *   to amortize the syscall overhead from `randomBytes`. Even with
 *   ~3% rejection rate (8/256) we almost always have enough usable
 *   bytes in the buffer.
 *
 * Caller is responsible for checking the result against the DB and
 * retrying on collision; this function does NOT touch the database.
 *
 * @returns a SHORT_CODE_LENGTH-char Base62 string, never a reserved
 *          word.
 */
export function generateShortCode(): string {
  // Largest multiple of 62 ≤ 256, used to reject bytes that would
  // introduce modulo bias. 62*4 = 248.
  const SAFE_CEILING = 248;

  while (true) {
    let out = '';
    let buf = randomBytes(32);
    let bufIdx = 0;

    while (out.length < SHORT_CODE_LENGTH) {
      if (bufIdx >= buf.length) {
        buf = randomBytes(32);
        bufIdx = 0;
      }
      const byte = buf[bufIdx]!;
      bufIdx++;
      // Rejection sampling: skip biased bytes, redraw.
      if (byte >= SAFE_CEILING) continue;
      out += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
    }

    // Avoid issuing reserved codes. Probability ≈ 30/(62^7) so this
    // effectively never loops, but the check is cheap.
    if (!RESERVED_CODES.has(out.toLowerCase())) return out;
  }
}
