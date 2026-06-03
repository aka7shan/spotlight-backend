-- =====================================================================
-- 0001 — Enable Row-Level Security on all public.* tables
-- =====================================================================
--
-- Defense-in-depth. Our Hono backend connects as the Supabase pooler's
-- postgres role, which has BYPASSRLS, so these policies are NOT what
-- protects the API — that's the JWT middleware + the `eq(user_id, ...)`
-- filter on every query.
--
-- The policies kick in only when something *outside* our backend touches
-- these tables: a Supabase JS client using the anon key (we'll need this
-- for direct Storage operations soon), the Supabase SQL editor under a
-- non-superuser, etc. Without these policies enabled, an anon-key client
-- would have full SELECT access to every user's profile and child data.
--
-- The policy shape is the same for every table: only the row's owner can
-- see or modify it. `auth.uid()` is Supabase's helper that pulls `sub`
-- out of the JWT in the request session.
--
-- How to apply
-- ------------
--  Option A (preferred for one-off, safe to run on prod):
--    1. Open the Supabase Dashboard -> SQL Editor.
--    2. Paste this file's contents.
--    3. Run. The script is idempotent (DROP IF EXISTS + CREATE), so
--       re-running is safe.
--
--  Option B (Drizzle migrate):
--    From the backend repo root, with DATABASE_URL set:
--      npm run db:migrate
--    This applies any drizzle/*.sql files that haven't been recorded in
--    the migrations metadata table yet.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Enable RLS on every table we own.
-- ---------------------------------------------------------------------
ALTER TABLE "public"."profiles"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."skills"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."experiences"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."educations"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."projects"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."certifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."achievements"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."languages"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."portfolios"     ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2. Self-access policies.
--
-- profiles uses `user_id` as both PK and ownership column.
-- All child tables have a `user_id` FK -> profiles(user_id).
-- The policy is identical in shape across all of them.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles_self_access" ON "public"."profiles";
CREATE POLICY "profiles_self_access" ON "public"."profiles"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "skills_self_access" ON "public"."skills";
CREATE POLICY "skills_self_access" ON "public"."skills"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "experiences_self_access" ON "public"."experiences";
CREATE POLICY "experiences_self_access" ON "public"."experiences"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "educations_self_access" ON "public"."educations";
CREATE POLICY "educations_self_access" ON "public"."educations"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "projects_self_access" ON "public"."projects";
CREATE POLICY "projects_self_access" ON "public"."projects"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "certifications_self_access" ON "public"."certifications";
CREATE POLICY "certifications_self_access" ON "public"."certifications"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "achievements_self_access" ON "public"."achievements";
CREATE POLICY "achievements_self_access" ON "public"."achievements"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "languages_self_access" ON "public"."languages";
CREATE POLICY "languages_self_access" ON "public"."languages"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "portfolios_self_access" ON "public"."portfolios";
CREATE POLICY "portfolios_self_access" ON "public"."portfolios"
  FOR ALL
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 3. Phase 1 placeholder (intentionally NOT applied yet):
--
--    When we ship shareable portfolio URLs, we'll need anonymous SELECT
--    on:
--        portfolios     WHERE is_published = true
--      + profiles, skills, experiences, …  WHERE user_id IN (the
--        published portfolio's owner)
--
--    That's a bigger policy surface (the child tables need to expose
--    only the published owner's rows, not all rows) so we'll write it
--    when we wire the public viewer route.
-- ---------------------------------------------------------------------
