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
