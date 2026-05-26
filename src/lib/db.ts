import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { requireDatabase } from '../env.js';
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
 */

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (_db) return _db;
  const url = requireDatabase();

  _sql = postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 5,
  });

  _db = drizzle(_sql, { schema, casing: 'snake_case' });
  return _db;
}

/** Convenience export — call getDb() once and reuse the singleton */
export type Database = ReturnType<typeof getDb>;
