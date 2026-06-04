-- =====================================================================
-- 0002 — Storage buckets for user-uploaded files
-- =====================================================================
--
-- Creates the buckets that Phase 1 needs:
--   - "avatars"  (public)  — profile pictures
--   - "covers"   (public)  — profile cover/banner images (Phase 1.x)
--   - "cvs"      (private) — uploaded CVs/résumés (Phase 1.2)
--
-- Why each is public/private:
--   - Avatars and cover images need to be embeddable in <img src="…">
--     anywhere a portfolio is rendered (including by unauthenticated
--     visitors on shareable URLs), so they're public. Path-only
--     enumeration is the security boundary, which means filenames
--     must NOT be guessable (we use the user_id as the path, which is
--     a UUID — knowing someone's avatar URL means you already had
--     their user id).
--   - CVs are private. The backend issues short-lived signed URLs to
--     the owner only.
--
-- How to apply
-- ------------
--  Supabase Dashboard → SQL Editor → paste this file → Run.
--  Idempotent (uses ON CONFLICT and DROP POLICY IF EXISTS).
--
-- Defense-in-depth note
-- ---------------------
--  Our backend connects via the postgres pooler superuser, which has
--  BYPASSRLS — so the policies below don't constrain it. They DO
--  constrain anyone who ever talks to Storage with the anon key (e.g.
--  a future direct-from-browser upload path). Today the Phase 1.0 flow
--  routes every byte through the backend, so the backend's own auth
--  checks (requireAuth + size/type validation) are what's keeping the
--  bucket clean. The policies are insurance.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Create the buckets.
-- ---------------------------------------------------------------------
--
-- `public = true` makes objects readable via the public CDN URL without
-- a signed request. Doesn't affect WRITE access — those policies live
-- in storage.objects below.
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

INSERT INTO storage.buckets (id, name, public)
VALUES ('covers', 'covers', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

INSERT INTO storage.buckets (id, name, public)
VALUES ('cvs', 'cvs', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ---------------------------------------------------------------------
-- 2. RLS policies on storage.objects.
--
-- Storage filenames in all three buckets follow the convention:
--     {user_id}/{anything}
-- e.g. "avatars/3f5a…-uuid/profile.webp". The first path segment is
-- the owner's auth.uid(); we enforce that via the policy's USING
-- clause so an anon-key uploader can only write into their own folder.
--
-- We split policies per operation so a future "allow public read of
-- any avatar" stays trivially expressible (the SELECT policy on
-- avatars is already public via the bucket's `public = true` flag, so
-- no explicit SELECT policy is needed for read).
-- ---------------------------------------------------------------------

-- Avatars: owner can write/update/delete their own files.
DROP POLICY IF EXISTS "avatars_owner_insert" ON storage.objects;
CREATE POLICY "avatars_owner_insert" ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "avatars_owner_update" ON storage.objects;
CREATE POLICY "avatars_owner_update" ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "avatars_owner_delete" ON storage.objects;
CREATE POLICY "avatars_owner_delete" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Covers: same shape as avatars.
DROP POLICY IF EXISTS "covers_owner_insert" ON storage.objects;
CREATE POLICY "covers_owner_insert" ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'covers'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "covers_owner_update" ON storage.objects;
CREATE POLICY "covers_owner_update" ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'covers'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "covers_owner_delete" ON storage.objects;
CREATE POLICY "covers_owner_delete" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'covers'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- CVs: same shape, plus owner-only SELECT (the bucket is private so
-- no public CDN reads — only the owner can list/download their own
-- files, plus the backend via service role).
DROP POLICY IF EXISTS "cvs_owner_select" ON storage.objects;
CREATE POLICY "cvs_owner_select" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'cvs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "cvs_owner_insert" ON storage.objects;
CREATE POLICY "cvs_owner_insert" ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'cvs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "cvs_owner_update" ON storage.objects;
CREATE POLICY "cvs_owner_update" ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'cvs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "cvs_owner_delete" ON storage.objects;
CREATE POLICY "cvs_owner_delete" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'cvs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------
-- 3. One-time cleanup for any pre-1.0 data: URLs.
--
-- Phase 0 wrote avatars as `data:image/...;base64,...` strings directly
-- into profiles.avatar_url. Phase 1.0 caps that column at 2 KB (URL only).
-- An old data URL surviving in the DB would 422 the next PUT /v1/me from
-- that user. We clear those out unconditionally — the user can re-upload
-- via the new flow.
-- ---------------------------------------------------------------------
UPDATE public.profiles
   SET avatar_url = NULL
 WHERE avatar_url LIKE 'data:%';

UPDATE public.profiles
   SET cover_url = NULL
 WHERE cover_url LIKE 'data:%';
