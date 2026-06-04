/**
 * Username / slug helpers.
 *
 * Phase 1.1 uses the existing `profiles.username` column as the public URL
 * slug (e.g. /spotlight/<username>). The DB has a CHECK constraint enforcing
 * the format already; this module mirrors it on the application side so we
 * can return clean 400s instead of opaque 23514 (check_violation) errors,
 * and so we can layer a reserved-word block on top.
 *
 * DB constraint reference (drizzle/0000_*.sql):
 *   ^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$
 *
 * Translated:
 *   - 1 char  → must be [a-z0-9]
 *   - 3+ chars → starts and ends with [a-z0-9], middle is [a-z0-9-]
 *   - 2-char usernames are NOT allowed by the DB regex
 *   - max length 32
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

const FORMAT_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const NO_DOUBLE_HYPHEN_RE = /--/;

/**
 * Reserved usernames that we never let users claim because they'd collide
 * with our routes, internal paths, marketing pages, or look-alike spoofs.
 *
 * Kept as a Set for O(1) lookup. All entries are lowercase.
 */
const RESERVED_USERNAMES = new Set<string>([
  // Our own product paths (frontend + backend)
  'spotlight',
  'admin',
  'administrator',
  'api',
  'app',
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'logout',
  'verify',
  'callback',
  'oauth',
  'session',
  'sessions',

  // Common public pages we might add later
  'about',
  'help',
  'support',
  'contact',
  'terms',
  'privacy',
  'pricing',
  'docs',
  'blog',
  'home',
  'index',
  'pages',
  'templates',
  'examples',
  'demo',

  // Backend route prefixes we already use
  'me',
  'v1',
  'public',
  'health',

  // Profile chrome (in case we add nested pages later)
  'u',
  'user',
  'users',
  'p',
  'profile',
  'profiles',
  'settings',
  'account',
  'accounts',
  'dashboard',
  'edit',
  'new',

  // Generic but high-risk look-alikes
  'null',
  'undefined',
  'true',
  'false',
  'root',
  'system',
  'www',
  'mail',
  'email',
  'ftp',
  'localhost',
  'test',
  'tests',

  // Anti-impersonation
  'aka7shan', // current dev account — protect it for now (remove once shipped)
]);

export type UsernameValidationError =
  | { code: 'too_short'; message: string }
  | { code: 'too_long'; message: string }
  | { code: 'invalid_format'; message: string }
  | { code: 'reserved'; message: string };

/**
 * Validate a username candidate. Returns null on success, otherwise an
 * error object whose `code` is stable for the API contract and `message`
 * is intended for direct display in the UI.
 *
 * Does NOT check uniqueness — that's a DB round-trip and lives in the
 * service layer.
 */
export function validateUsername(raw: string): UsernameValidationError | null {
  if (typeof raw !== 'string') {
    return { code: 'invalid_format', message: 'Username must be a string.' };
  }

  if (raw.length < USERNAME_MIN_LENGTH) {
    return {
      code: 'too_short',
      message: `Username must be at least ${USERNAME_MIN_LENGTH} characters.`,
    };
  }

  if (raw.length > USERNAME_MAX_LENGTH) {
    return {
      code: 'too_long',
      message: `Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`,
    };
  }

  if (!FORMAT_RE.test(raw)) {
    return {
      code: 'invalid_format',
      message:
        'Use lowercase letters, numbers, and hyphens. Must start and end with a letter or number.',
    };
  }

  if (NO_DOUBLE_HYPHEN_RE.test(raw)) {
    return {
      code: 'invalid_format',
      message: 'Username cannot contain two hyphens in a row.',
    };
  }

  if (RESERVED_USERNAMES.has(raw)) {
    return {
      code: 'reserved',
      message: 'This username is reserved. Please choose another.',
    };
  }

  return null;
}

/**
 * True iff the username passes every check above. Convenience for places
 * that just want a boolean (the reserved-word handling above is the only
 * reason validateUsername returns structured errors).
 */
export function isValidUsername(raw: string): boolean {
  return validateUsername(raw) === null;
}

// ---------------------------------------------------------------------------
// Base62 random suggestions
// ---------------------------------------------------------------------------
//
// Phase 1.1 doesn't force a random username on anyone — every account already
// has a derived-from-email default. But the frontend's "Get a random
// suggestion" button hits an endpoint that calls this. Base62 keeps URLs
// short and copy-safe (no ambiguous characters like 0/O, l/1 — well, this
// is full base62 which includes those, but we don't need maximum readability
// for an opt-in random suggestion; readability matters more for
// auto-generated, system-assigned IDs which we don't have).

const BASE62_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Generate a candidate username suggestion. 8 chars base62 ≈ 47 bits of
 * entropy — collision-free for the foreseeable future.
 *
 * Note: the DB CHECK constraint is lowercase-only, so we MUST lowercase the
 * output. That drops us to base36 effectively (~41 bits over 8 chars), still
 * fine for our scale.
 */
export function generateRandomUsername(length = 8): string {
  const buf = new Uint8Array(length);
  // Node 18+: globalThis.crypto.getRandomValues. No need to import 'node:crypto'.
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i++) {
    // `!` asserts non-undefined: i is strictly < length, and we just
    // allocated `buf` with that length. Same for the alphabet lookup
    // (modulo guarantees the index is in range).
    const byte = buf[i]!;
    out += BASE62_ALPHABET[byte % BASE62_ALPHABET.length]!;
  }
  return out.toLowerCase();
}
