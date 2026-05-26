import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this file when running `npm run db:generate` / `db:push`.
 * It uses DATABASE_URL from .env, so make sure that's set before running.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Tables Drizzle should ignore (Supabase-managed)
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
