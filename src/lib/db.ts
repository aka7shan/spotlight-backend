import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from '../db/schema.js';

/**
 * Drizzle + postgres-js client.
 *
 * On Vercel (serverless) we'll get cold starts that create a fresh module
 * instance each time, so connection pooling MUST be handled by the
 * Supabase Pooler (port 6543). Use the "Transaction" pooler URL.
 *
 * The `max: 1` and `prepare: false` settings are required for the transaction
 * pooler. See https://supabase.com/docs/guides/database/connecting-to-postgres
 *
 * Pre-warm strategy
 * -----------------
 *  The postgres-js client is created at module load when DATABASE_URL is set,
 *  so the TCP/TLS handshake overlaps with the rest of cold start (route
 *  registration, JWKS init, etc.) instead of being paid on the first request.
 *
 *  If DATABASE_URL is missing we still load — health checks etc. should keep
 *  working — and `getDb()` will throw the same useful error it used to.
 */

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

function createClient(url: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 5,
  });
}

// Eagerly initialize during cold start when the URL is configured. Wrapped in
// try/catch so an invalid URL doesn't bring down the whole module — the next
// `getDb()` call will throw a clearer error.
if (env.DATABASE_URL) {
  try {
    _sql = createClient(env.DATABASE_URL);
    _db = drizzle(_sql, { schema, casing: 'snake_case' });
  } catch (err) {
    console.error(
      '[db] failed to create client during cold start; will retry on first getDb() call',
      err,
    );
    _sql = null;
    _db = null;
  }
}

export function getDb() {
  if (_db) return _db;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');

  _sql = createClient(env.DATABASE_URL);
  _db = drizzle(_sql, { schema, casing: 'snake_case' });
  return _db;
}

/**
 * Cheap liveness probe — used by /health/deep to verify the database is
 * actually reachable. Returns the round-trip duration in ms, throws on
 * failure. We use a short timeout so a hung pool doesn't block the
 * serverless function for its full maxDuration.
 */
export async function pingDb(timeoutMs = 2000): Promise<number> {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  const sql = _sql ?? createClient(env.DATABASE_URL);
  _sql = sql;

  const start = Date.now();
  // postgres-js doesn't expose per-query timeouts, so race against a timer.
  await Promise.race([
    sql`select 1`,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`DB ping timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
  return Date.now() - start;
}

/** Convenience export — call getDb() once and reuse the singleton */
export type Database = ReturnType<typeof getDb>;
