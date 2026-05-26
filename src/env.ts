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
 * We allow startup with these unset so the /health endpoint works
 * even before Supabase is configured.
 */
export function requireSupabase(): {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret?: string;
} {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase env vars are not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return {
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    jwtSecret: env.SUPABASE_JWT_SECRET,
  };
}

export function requireDatabase(): string {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return env.DATABASE_URL;
}
