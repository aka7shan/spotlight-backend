-- ---------------------------------------------------------------------------
-- Spotlight — Supabase-specific extras to run AFTER the Drizzle migration.
-- 1) Link profiles.user_id to auth.users
-- 2) Trigger that auto-creates a profile when a new auth.user signs up
-- 3) Auto-update `updated_at` triggers
-- 4) Row-Level Security policies
-- ---------------------------------------------------------------------------

-- ============================================================================
-- 1. FK profiles.user_id -> auth.users.id (cascade delete)
--    Drizzle can't reference Supabase's auth.users table, so we add this
--    by hand. Cascade ensures: delete the Supabase user -> all their data goes.
-- ============================================================================

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_user_id_auth_users_fk
  FOREIGN KEY (user_id) REFERENCES auth.users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================================================
-- 2. Auto-create profile on signup
--    Generates a default username from email or uses random fallback.
--    A SECURITY DEFINER function runs with elevated privileges so it can
--    insert into our table from inside the auth schema.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate text;
  attempt int := 0;
BEGIN
  -- Build a username from the email local part (sanitized).
  candidate := regexp_replace(
    coalesce(split_part(NEW.email, '@', 1), 'user'),
    '[^a-z0-9-]', '', 'gi'
  );
  candidate := lower(candidate);
  IF length(candidate) < 3 THEN
    candidate := 'user-' || substr(replace(NEW.id::text, '-', ''), 1, 8);
  END IF;

  -- Try to insert; on conflict, append a random suffix and retry a few times.
  LOOP
    BEGIN
      INSERT INTO public.profiles (user_id, username, email, name)
      VALUES (
        NEW.id,
        candidate,
        NEW.email,
        coalesce(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', '')
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      attempt := attempt + 1;
      IF attempt > 5 THEN
        candidate := 'user-' || substr(replace(NEW.id::text, '-', ''), 1, 12);
      ELSE
        candidate := candidate || '-' || substr(replace(NEW.id::text, '-', ''), 1, 4);
      END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 3. updated_at triggers
--    Postgres won't refresh `updated_at` on its own; we install a tiny
--    trigger on every table that has the column.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles', 'experiences', 'educations', 'projects',
    'certifications', 'achievements', 'portfolios'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS touch_updated_at ON public.%I;', t
    );
    EXECUTE format(
      'CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();', t
    );
  END LOOP;
END $$;

-- ============================================================================
-- 4. Row-Level Security
--
-- The rules:
--   - Authenticated users can SELECT / INSERT / UPDATE / DELETE only THEIR own rows.
--   - Anyone (including unauthenticated visitors) can SELECT profile + related
--     rows where the profile's portfolio is_published = true. (Read-only.)
--   - The service_role key (backend only) bypasses RLS automatically.
--
-- Frontend never holds the service_role key, so even if a malicious client
-- forges requests directly to Supabase, RLS keeps them inside their lane.
-- ============================================================================

ALTER TABLE public.profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skills         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiences    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.educations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.languages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolios     ENABLE ROW LEVEL SECURITY;

-- Helper: a profile is "publicly visible" if it has at least one published
-- portfolio. Used in SELECT-public policies on related tables.
CREATE OR REPLACE FUNCTION public.is_profile_public(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.portfolios
    WHERE user_id = p_user_id AND is_published = true
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles: owner full access"     ON public.profiles;
DROP POLICY IF EXISTS "profiles: public select"         ON public.profiles;

CREATE POLICY "profiles: owner full access"
  ON public.profiles
  FOR ALL
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "profiles: public select"
  ON public.profiles
  FOR SELECT
  TO anon, authenticated
  USING (public.is_profile_public(user_id));

-- ---------------------------------------------------------------------------
-- Owner-full + public-read-when-portfolio-is-published for related tables
-- Generated by a single DO block to keep the policy definitions consistent.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'skills', 'experiences', 'educations', 'projects',
    'certifications', 'achievements', 'languages'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s: owner full access" ON public.%1$I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s: public select"     ON public.%1$I;', t);

    EXECUTE format($p$
      CREATE POLICY "%1$s: owner full access"
        ON public.%1$I
        FOR ALL
        TO authenticated
        USING (user_id = (SELECT auth.uid()))
        WITH CHECK (user_id = (SELECT auth.uid()));
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY "%1$s: public select"
        ON public.%1$I
        FOR SELECT
        TO anon, authenticated
        USING (public.is_profile_public(user_id));
    $p$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- portfolios — slightly different: owner full access, anyone can read PUBLISHED
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "portfolios: owner full access" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios: public select"     ON public.portfolios;

CREATE POLICY "portfolios: owner full access"
  ON public.portfolios
  FOR ALL
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "portfolios: public select"
  ON public.portfolios
  FOR SELECT
  TO anon, authenticated
  USING (is_published = true);
