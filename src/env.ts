import { z } from 'zod';

/**
 * Zod-validated environment configuration.
 * Throws at startup if required vars are missing or malformed.
 *
 * Why validate? A typo'd env var fails at the first DB call (mysterious) instead
 * of at startup (obvious). This is the cheapest mistake-prevention you can buy.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),

  // Comma-separated list of allowed CORS origins
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // Legacy/default Supabase signs JWTs with HS256 + shared secret.
  // Newer "JWT Signing Keys" projects use asymmetric keys (JWKS endpoint).
  // We support both: if SUPABASE_JWT_SECRET is set we use HS256, else JWKS.
  // Values starting with `PASTE_` are treated as not-set so the user-facing
  // `.env` file can keep its placeholders without breaking the verifier.
  SUPABASE_JWT_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 && !v.startsWith('PASTE_') ? v : undefined)),

  // Postgres
  DATABASE_URL: z.string().url().optional(),

  // Upstash Redis (used as a hot cache in front of `/v1/p/:code`
  // lookups so anonymous portfolio views are served sub-ms when
  // already cached). Both must be set together, or neither — the
  // cache layer no-ops cleanly when unset so local dev works without
  // a Redis dependency.
  UPSTASH_REDIS_REST_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v && !v.startsWith('PASTE_') ? v : undefined)),
  UPSTASH_REDIS_REST_TOKEN: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v && !v.startsWith('PASTE_') ? v : undefined)),

  // Google Gemini (Phase 1.2 — CV parsing, and 1.3 — portfolio chat).
  // Optional at startup so the rest of the API stays online even if the
  // key isn't configured yet; routes that need it call `requireGemini()`
  // and fail with a clean 503 when the key is missing.
  //
  // Get a key at https://aistudio.google.com → "Get API key". Free tier:
  // 15 req/min, 1500 req/day, no card required.
  GEMINI_API_KEY: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v && !v.startsWith('PASTE_') ? v : undefined)),

  // Which Gemini model to use for structured-output extraction (CV
  // parsing). 2.0-flash is a great default: free-tier-friendly, strong
  // at JSON schema mode, and fast enough that a CV parse feels
  // interactive (~3-6s end-to-end).
  GEMINI_MODEL: z
    .string()
    .min(1)
    .default('gemini-2.0-flash'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(z.flattenError(parsed.error).fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env: Env = parsed.data;

/**
 * Helpers that throw if a required-for-feature variable is missing.
 *
 * We allow startup with optional Supabase/DB vars unset so /health works
 * even before the project is fully configured. The features that *need*
 * those vars call these helpers and get a clear error if they're missing.
 *
 * SUPABASE_URL is required so we can hit the JWKS endpoint when the project
 * uses asymmetric signing keys. SUPABASE_ANON_KEY is required to be
 * *present* even though the verifier itself doesn't use it — it's our
 * sanity check that the Supabase env is actually wired up (clients use
 * the anon key to mint tokens in the first place).
 */
export function requireSupabaseAuth(): {
  url: string;
  jwtSecret?: string;
} {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase auth env vars are not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.',
    );
  }
  return {
    url: env.SUPABASE_URL,
    jwtSecret: env.SUPABASE_JWT_SECRET,
  };
}

/**
 * For server-side Supabase operations that need to bypass RLS — Storage
 * uploads, admin actions, etc. NEVER expose this key to the frontend or
 * to any code that runs in the browser.
 *
 * Returns BOTH the URL and the key because the supabase-js client needs
 * the URL to know which project to talk to. They're a pair, not two
 * independent secrets.
 */
export function requireSupabaseService(): { url: string; serviceRoleKey: string } {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase service env vars are not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/**
 * Throw a typed error if the Gemini API key isn't configured. Used by the
 * CV-parse and chat routes so a missing key surfaces as a clean 503
 * "feature unavailable" instead of a confusing 500 from deep inside the
 * Google SDK.
 *
 * We return the model name alongside the key so callers don't have to
 * read `env` twice (and so swapping models later stays a one-env-var
 * change with no code edits).
 */
export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      'Gemini API is not configured. Set GEMINI_API_KEY in the backend environment.',
    );
    this.name = 'GeminiNotConfiguredError';
  }
}

export function requireGemini(): { apiKey: string; model: string } {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiNotConfiguredError();
  }
  return {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
  };
}
