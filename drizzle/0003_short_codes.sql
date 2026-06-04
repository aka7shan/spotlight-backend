-- =====================================================================
-- 0003 — Public short codes for portfolios
-- =====================================================================
--
-- Phase 1.2 replaces the username-based public URL scheme
-- (`/spotlight/<username>`) with a Base62 short-code scheme
-- (`/p/<short_code>`). Each portfolio row gets a fixed-length random
-- code that is globally unique and immutable for the life of that code
-- (regeneration issues a *new* code and the old one stops working).
--
-- Why a partial unique index instead of NOT NULL?
-- -----------------------------------------------
-- We need to ship this migration on an existing populated table without
-- a chicken-and-egg problem: the column must exist before the backend
-- can populate it, but NOT NULL would reject the ALTER TABLE on any row
-- that already exists. So we:
--
--   1. Add the column nullable.
--   2. Add a partial unique index that only enforces uniqueness on the
--      *populated* subset. Multiple NULLs are allowed; two equal
--      non-null values are not.
--   3. Backfill happens lazily in the backend (`ensureShortCode`) on
--      first GET /v1/me — which is the same call the frontend makes
--      immediately after login, so users get a code within milliseconds
--      of their first authenticated request.
--
-- This same approach scales cleanly when we later add a NOT NULL
-- constraint (after backfill is complete in production) without a
-- multi-step migration.
-- =====================================================================

alter table portfolios
  add column if not exists short_code text;

-- Partial unique index: enforces global uniqueness across non-null codes.
-- Postgres treats NULLs as distinct in a regular unique index, but being
-- explicit with the WHERE clause makes the intent visible in pg_dump and
-- in Drizzle's introspection.
create unique index if not exists portfolios_short_code_uniq
  on portfolios (short_code)
  where short_code is not null;

-- Lookup index covers `where short_code = $1` queries. Strictly the
-- unique index above already serves these (Postgres can use a unique
-- index as a btree), but keeping it explicit means any future change
-- to the unique index's predicate doesn't silently hurt lookup
-- performance.
create index if not exists portfolios_short_code_lookup
  on portfolios (short_code);
