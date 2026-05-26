# Supabase migrations

This folder holds Supabase-specific SQL that lives *outside* Drizzle:

| File | What it does |
|---|---|
| `migrations/0001_auth_link_and_rls.sql` | Links `profiles.user_id` to `auth.users`, adds the auto-create-profile-on-signup trigger, `updated_at` triggers, and **Row-Level Security policies** for every table. |

## How to apply (Phase 0)

The Drizzle-generated tables live in `drizzle/0000_*.sql`.
Once Supabase credentials are set, run:

```bash
# From this repo root:
npm run db:migrate           # applies the Drizzle migration

# Then apply this folder's SQL via the Supabase SQL editor
# (Dashboard -> SQL Editor -> paste the contents of 0001_*.sql -> Run)
```

You can also apply both via the Supabase CLI if you set it up later — see
`docs/PHASE-0.md`.

## Why is RLS in here, not in Drizzle?

Drizzle doesn't model PostgreSQL `POLICY` statements, and Supabase RLS is
heavily intertwined with the `auth.uid()` helper and the `auth.users` table.
Keeping it as plain SQL means you can read and audit it directly — which
matters because **RLS is your last line of defense** if any frontend code
ever talks to Supabase with the anon key.
