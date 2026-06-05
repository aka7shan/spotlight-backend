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

  // ---- LLM provider configuration ----
  //
  // We support two providers behind a single `generateStructured()`
  // surface in `lib/llm.ts`:
  //   - Groq   (primary)   — Llama 3.3 70B via tool-calling. Truly free
  //                          tier (no billing-link required), ~3-5x
  //                          faster than Gemini.
  //   - Gemini (fallback)  — kept wired so a Groq outage degrades
  //                          gracefully rather than failing the whole
  //                          feature.
  //
  // Routes don't care which one served their request. They just call
  // `generateStructured` and the dispatcher picks based on `LLM_PROVIDER`
  // (with auto-fallback to the OTHER provider on quota/transient errors,
  // when both are configured).
  //
  // `LLM_PROVIDER` is intentionally a tight enum so a typo
  // (`LLM_PROVIDER=Grok` instead of `groq`) fails at startup with a
  // clear Zod error rather than silently routing to Gemini.

  LLM_PROVIDER: z
    .enum(['groq', 'gemini'])
    .default('groq'),

  // Groq — get a free key at https://console.groq.com (no card required).
  // The `PASTE_` prefix dance matches the other secrets so the .env file
  // can carry a placeholder without breaking startup.
  GROQ_API_KEY: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v && !v.startsWith('PASTE_') ? v : undefined)),

  // Which Groq model to use for structured-output extraction. Llama 3.3
  // 70B Versatile is the current sweet spot on the free tier: highest
  // quality structured-output (via tool calling) + reasonable 30 RPM
  // ceiling. If we later want speed over quality, switch to
  // `llama-3.1-8b-instant`.
  GROQ_MODEL: z
    .string()
    .min(1)
    .default('llama-3.3-70b-versatile'),

  // Google Gemini — optional fallback provider (and primary for legacy
  // deployments where LLM_PROVIDER isn't yet set). Same `PASTE_`
  // placeholder convention as the other secrets.
  //
  // Get a key at https://aistudio.google.com → "Get API key". Free tier
  // requires a linked billing account in 2026, which is why we don't
  // recommend it as primary anymore.
  GEMINI_API_KEY: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v && !v.startsWith('PASTE_') ? v : undefined)),

  // Which Gemini model to use when Gemini serves a request (primary or
  // fallback). `gemini-2.0-flash` is the current free-tier flagship for
  // structured JSON extraction.
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
 * Typed errors for missing provider configuration.
 *
 * Both Groq and Gemini are optional at startup so the rest of the API
 * stays online even when AI features aren't wired up yet. The routes
 * that need them call `requireGroq()` / `requireGemini()` and throw
 * one of these — which `lib/llm.ts` translates into a 503 for the
 * client (cleaner than a 500 from deep inside an SDK).
 */
export class GroqNotConfiguredError extends Error {
  constructor() {
    super(
      'Groq API is not configured. Set GROQ_API_KEY in the backend environment.',
    );
    this.name = 'GroqNotConfiguredError';
  }
}

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      'Gemini API is not configured. Set GEMINI_API_KEY in the backend environment.',
    );
    this.name = 'GeminiNotConfiguredError';
  }
}

export function requireGroq(): { apiKey: string; model: string } {
  if (!env.GROQ_API_KEY) {
    throw new GroqNotConfiguredError();
  }
  return {
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
  };
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

/**
 * Generic "no AI provider configured at all" error. Used by the LLM
 * dispatcher when the request's primary provider is missing AND no
 * fallback provider is configured either — at that point we can't
 * serve the request and the route should return 503.
 */
export class NoLlmProviderConfiguredError extends Error {
  constructor() {
    super(
      'No AI provider is configured. Set either GROQ_API_KEY (preferred) or GEMINI_API_KEY in the backend environment.',
    );
    this.name = 'NoLlmProviderConfiguredError';
  }
}
