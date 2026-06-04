import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseService } from '../env.js';

/**
 * Server-side Supabase Storage helper.
 *
 * Uses the SERVICE_ROLE key (kept secret on the backend) so it can bypass
 * storage RLS policies. The policies in drizzle/0002_storage_buckets.sql
 * exist for defense-in-depth: they only constrain anon-key callers, which
 * the backend never is.
 *
 * Client is lazily constructed on first use so module load doesn't fail
 * when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set (e.g. when only
 * /health is being exercised).
 *
 * Bucket conventions
 * ------------------
 *   avatars/{user_id}/avatar.{ext}      public, overwritten on re-upload
 *   covers/{user_id}/cover.{ext}        public, overwritten on re-upload
 *   cvs/{user_id}/{timestamp}-{name}    private, versioned (we keep history)
 */

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const { url, serviceRoleKey } = requireSupabaseService();
  _client = createClient(url, serviceRoleKey, {
    auth: {
      // Server-side: never persist the session, never auto-refresh.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return _client;
}

// ---------------------------------------------------------------------------
// Allowed MIME types & extensions
// ---------------------------------------------------------------------------
//
// We validate the file's declared content-type AND derive the extension from
// it (not from the original filename, which is user-controlled and unsafe).
// jpeg + jpg are treated as one type; webp is included because modern phones
// produce it by default and rejecting it is hostile UX.

const AVATAR_MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export const ALLOWED_AVATAR_MIME_TYPES = Object.keys(AVATAR_MIME_TO_EXT);

/** Hard ceiling on uploaded avatar size. Tracks the platform body limit. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

// Cover images share the same MIME palette as avatars (every browser-decodable
// format), but get their own constant so we can tune them independently
// later — e.g. accept AVIF, raise the size limit, or restrict to wide-aspect
// types — without disturbing avatar behavior.
const COVER_MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export const ALLOWED_COVER_MIME_TYPES = Object.keys(COVER_MIME_TO_EXT);

/**
 * Hard ceiling on uploaded cover size. Covers are usually landscape and
 * larger than avatars, but we keep them within the same 5 MB envelope so
 * the global 6 MB Hono body limit covers (pun unintended) multipart
 * boundaries + form fields with room to spare.
 */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

// CVs — Phase 1.2.
// Accepted formats: PDF (the overwhelming majority), DOCX (the common
// Word format), and DOC (legacy Word — we accept the bytes but the text
// extractor only handles DOCX, so DOC uploads will succeed but parse
// will fail with a clear message). We DO NOT accept image-only PDFs at
// the storage layer (no way to tell from MIME); the parser handles that
// gracefully with a "we couldn't read text" error.
const CV_MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
});

export const ALLOWED_CV_MIME_TYPES = Object.keys(CV_MIME_TO_EXT);

/**
 * Hard ceiling on uploaded CV size.
 *
 * Chosen at 4 MB because:
 *   - Vercel Hobby has a 4.5 MB platform-level body limit; we want our
 *     own limit to trip first with a clean 413 JSON envelope before
 *     Vercel returns its opaque error.
 *   - Real CVs are 50 KB – 2 MB. Anything > 4 MB is almost always a
 *     scanned-image PDF (no text layer) that the parser can't read
 *     anyway; rejecting at upload time saves the user a confusing
 *     "we couldn't extract anything" message later.
 */
export const MAX_CV_BYTES = 4 * 1024 * 1024;

/** How long a signed URL for the user's own CV stays valid. 10 min is
 *  plenty for a "Download my CV" click + a quick AI-parse round-trip. */
const CV_SIGNED_URL_TTL_SECONDS = 600;

export class StorageError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Avatar operations
// ---------------------------------------------------------------------------

/**
 * Upload (or replace) the current user's avatar.
 *
 * @returns The public CDN URL of the uploaded avatar.
 * @throws StorageError(413) if the file is too large.
 * @throws StorageError(415) if the MIME type isn't allowed.
 * @throws StorageError(500) on any other Supabase failure.
 */
export async function uploadAvatar(
  userId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new StorageError(
      `Avatar exceeds ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB limit.`,
      413,
    );
  }
  const ext = AVATAR_MIME_TO_EXT[contentType];
  if (!ext) {
    throw new StorageError(
      `Unsupported avatar type "${contentType}". Allowed: ${ALLOWED_AVATAR_MIME_TYPES.join(', ')}.`,
      415,
    );
  }

  // We use a deterministic path (same filename across uploads) and rely on
  // `upsert: true` so re-uploads overwrite cleanly. This keeps the Storage
  // browser tidy (no orphan files) and lets the avatar URL remain stable
  // across edits — important for caching, SEO, and og:image.
  //
  // Cache-busting is handled by the timestamp query param below.
  const path = `${userId}/avatar.${ext}`;

  const client = getClient();
  const { error } = await client.storage.from('avatars').upload(path, bytes, {
    contentType,
    upsert: true,
    cacheControl: '3600',
  });
  if (error) {
    console.error('[storage] avatar upload failed', { userId, error });
    throw new StorageError(`Avatar upload failed: ${error.message}`);
  }

  // Public URL never changes for a given (bucket, path). Append a timestamp
  // query string so the browser doesn't serve the stale cached copy after
  // a re-upload.
  const { data: pub } = client.storage.from('avatars').getPublicUrl(path);
  return `${pub.publicUrl}?v=${Date.now()}`;
}

/**
 * Remove the current user's avatar from Storage.
 * No-op if no file exists (Supabase returns success on missing-path delete).
 */
export async function deleteAvatar(userId: string): Promise<void> {
  const client = getClient();

  // We don't know the extension here, so list and delete everything under
  // the user's avatar folder. There should only ever be one file (we use
  // `upsert: true` on the same path), but this protects against any drift.
  const { data: files, error: listError } = await client.storage
    .from('avatars')
    .list(userId);
  if (listError) {
    console.error('[storage] avatar list failed', { userId, error: listError });
    throw new StorageError(`Avatar delete failed: ${listError.message}`);
  }
  if (!files || files.length === 0) return;

  const paths = files.map((f) => `${userId}/${f.name}`);
  const { error: removeError } = await client.storage.from('avatars').remove(paths);
  if (removeError) {
    console.error('[storage] avatar remove failed', { userId, paths, error: removeError });
    throw new StorageError(`Avatar delete failed: ${removeError.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cover operations
// ---------------------------------------------------------------------------
//
// Structurally identical to the avatar helpers above, but kept as a separate
// pair (not generalized into one `uploadImage(bucket, ...)`) for three
// reasons:
//   1. Error messages stay specific ("Cover exceeds 5 MB" vs a vague "Image").
//   2. Each surface can evolve independently — covers may grow an AVIF
//      allowance, a different size cap, or thumbnail post-processing.
//   3. The call sites (routes/me.ts) read more clearly with a distinct verb.

/**
 * Upload (or replace) the current user's cover image.
 *
 * @returns The public CDN URL of the uploaded cover, with a cache-busting
 *          `?v=<timestamp>` query string.
 * @throws StorageError(413) if the file is too large.
 * @throws StorageError(415) if the MIME type isn't allowed.
 * @throws StorageError(500) on any other Supabase failure.
 */
export async function uploadCover(
  userId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (bytes.byteLength > MAX_COVER_BYTES) {
    throw new StorageError(
      `Cover exceeds ${Math.round(MAX_COVER_BYTES / 1024 / 1024)} MB limit.`,
      413,
    );
  }
  const ext = COVER_MIME_TO_EXT[contentType];
  if (!ext) {
    throw new StorageError(
      `Unsupported cover type "${contentType}". Allowed: ${ALLOWED_COVER_MIME_TYPES.join(', ')}.`,
      415,
    );
  }

  // Same `cover.<ext>` deterministic-path scheme as avatars: re-uploads
  // overwrite cleanly via upsert, the Storage browser stays tidy, and the
  // bare URL is stable so caches and og:image references don't churn.
  // The ?v=<ts> below handles cache busting after a re-upload.
  const path = `${userId}/cover.${ext}`;

  const client = getClient();
  const { error } = await client.storage.from('covers').upload(path, bytes, {
    contentType,
    upsert: true,
    cacheControl: '3600',
  });
  if (error) {
    console.error('[storage] cover upload failed', { userId, error });
    throw new StorageError(`Cover upload failed: ${error.message}`);
  }

  const { data: pub } = client.storage.from('covers').getPublicUrl(path);
  return `${pub.publicUrl}?v=${Date.now()}`;
}

/**
 * Remove the current user's cover image from Storage.
 * No-op if no file exists (Supabase returns success on missing-path delete).
 */
export async function deleteCover(userId: string): Promise<void> {
  const client = getClient();

  const { data: files, error: listError } = await client.storage
    .from('covers')
    .list(userId);
  if (listError) {
    console.error('[storage] cover list failed', { userId, error: listError });
    throw new StorageError(`Cover delete failed: ${listError.message}`);
  }
  if (!files || files.length === 0) return;

  const paths = files.map((f) => `${userId}/${f.name}`);
  const { error: removeError } = await client.storage.from('covers').remove(paths);
  if (removeError) {
    console.error('[storage] cover remove failed', { userId, paths, error: removeError });
    throw new StorageError(`Cover delete failed: ${removeError.message}`);
  }
}

// ---------------------------------------------------------------------------
// CV operations (Phase 1.2)
// ---------------------------------------------------------------------------
//
// The `cvs` bucket is PRIVATE (see drizzle/0002_storage_buckets.sql). Two
// implications vs the avatar/cover plumbing:
//
//   1. Reads need a SIGNED URL — there's no public CDN URL. We mint one
//      with a 10-min TTL when the owner needs to download. The parse
//      endpoint reads the file via the service-role client directly and
//      never exposes the URL.
//
//   2. Storage path keeps the same `<userId>/<file>` shape so the
//      Storage RLS policy (first folder segment = auth.uid()) still
//      works when we later expose direct-from-browser uploads.

export interface CvUploadResult {
  /** Storage object path (e.g. "<userId>/resume.pdf"). Useful for the
   *  parse step which reads the file by path via the service client. */
  path: string;
  /** Short-lived signed URL (TTL = CV_SIGNED_URL_TTL_SECONDS). The
   *  frontend uses this for "Download my CV" — it expires fast, so
   *  callers shouldn't try to persist it. */
  signedUrl: string;
  /** Final size after the round-trip. Always equals input bytes.length —
   *  we surface it so callers don't have to track this themselves. */
  size: number;
  /** Echoed back so callers don't have to re-derive (and so we have a
   *  single source of truth for what got written). */
  contentType: string;
}

/**
 * Upload (or replace) the current user's CV.
 *
 * Stored at `cvs/<userId>/resume.<ext>` with `upsert: true` so re-uploads
 * overwrite cleanly. Same orphan-on-cross-format-swap caveat applies as
 * with avatars (e.g. PDF → DOCX leaves the old PDF behind) — we'll
 * sweep that during the storage-cleanup pass.
 *
 * @returns The Storage path + a short-lived signed URL.
 * @throws StorageError(413) if the file exceeds MAX_CV_BYTES.
 * @throws StorageError(415) if the MIME isn't on the allow-list.
 * @throws StorageError(500) on any other Supabase failure.
 */
export async function uploadCv(
  userId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<CvUploadResult> {
  if (bytes.byteLength > MAX_CV_BYTES) {
    throw new StorageError(
      `CV exceeds ${Math.round(MAX_CV_BYTES / 1024 / 1024)} MB limit.`,
      413,
    );
  }
  const ext = CV_MIME_TO_EXT[contentType];
  if (!ext) {
    throw new StorageError(
      `Unsupported CV type "${contentType}". Allowed: PDF, DOCX.`,
      415,
    );
  }

  const path = `${userId}/resume.${ext}`;
  const client = getClient();

  // Private bucket → no cacheControl needed (the signed URL has its
  // own TTL). Upsert true so re-uploads to the same path overwrite.
  const { error } = await client.storage.from('cvs').upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) {
    console.error('[storage] cv upload failed', { userId, error });
    throw new StorageError(`CV upload failed: ${error.message}`);
  }

  const { data: signed, error: signedError } = await client.storage
    .from('cvs')
    .createSignedUrl(path, CV_SIGNED_URL_TTL_SECONDS);
  if (signedError || !signed?.signedUrl) {
    console.error('[storage] cv signed-url failed', { userId, error: signedError });
    throw new StorageError(`CV upload succeeded but signed-URL minting failed.`);
  }

  return {
    path,
    signedUrl: signed.signedUrl,
    size: bytes.byteLength,
    contentType,
  };
}

/**
 * Read the raw bytes of a user's CV back out of Storage.
 *
 * Used by the parse pipeline: after the user has uploaded a CV, the
 * parse endpoint fetches the bytes server-side (via the service-role
 * client, bypassing RLS) and feeds them to the text extractor + LLM.
 * We never hand these bytes to the visitor.
 *
 * Returns null if no CV exists at the expected path; the caller turns
 * that into a clean 404 "upload a CV first" instead of letting the
 * error bubble.
 */
export async function downloadCvBytes(
  userId: string,
  ext: 'pdf' | 'docx' | 'doc',
): Promise<Uint8Array | null> {
  const client = getClient();
  const path = `${userId}/resume.${ext}`;
  const { data, error } = await client.storage.from('cvs').download(path);
  if (error) {
    // Treat "not found" specifically so the route can return 404. Supabase
    // gives us a 404 in error.message — checking the status field is more
    // brittle than checking the message.
    if (error.message?.toLowerCase().includes('not found')) return null;
    console.error('[storage] cv download failed', { userId, error });
    throw new StorageError(`CV download failed: ${error.message}`);
  }
  if (!data) return null;
  const arrayBuf = await data.arrayBuffer();
  return new Uint8Array(arrayBuf);
}

/**
 * Mint a fresh signed URL for the user's CV. Useful if the original
 * URL from upload expired before the user clicked it.
 *
 * Returns null if no CV exists, so the route can 404 cleanly.
 */
export async function getCvSignedUrl(
  userId: string,
  ext: 'pdf' | 'docx' | 'doc',
): Promise<string | null> {
  const client = getClient();
  const path = `${userId}/resume.${ext}`;
  const { data, error } = await client.storage
    .from('cvs')
    .createSignedUrl(path, CV_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    if (error?.message?.toLowerCase().includes('not found')) return null;
    return null;
  }
  return data.signedUrl;
}

/**
 * Remove the current user's CV from Storage.
 * No-op if no file exists.
 */
export async function deleteCv(userId: string): Promise<void> {
  const client = getClient();

  const { data: files, error: listError } = await client.storage
    .from('cvs')
    .list(userId);
  if (listError) {
    console.error('[storage] cv list failed', { userId, error: listError });
    throw new StorageError(`CV delete failed: ${listError.message}`);
  }
  if (!files || files.length === 0) return;

  const paths = files.map((f) => `${userId}/${f.name}`);
  const { error: removeError } = await client.storage.from('cvs').remove(paths);
  if (removeError) {
    console.error('[storage] cv remove failed', { userId, paths, error: removeError });
    throw new StorageError(`CV delete failed: ${removeError.message}`);
  }
}

/** Helper: derive the canonical extension we use on disk from a MIME. */
export function cvMimeToExt(contentType: string): 'pdf' | 'docx' | 'doc' | null {
  const ext = CV_MIME_TO_EXT[contentType];
  if (ext === 'pdf' || ext === 'docx' || ext === 'doc') return ext;
  return null;
}
