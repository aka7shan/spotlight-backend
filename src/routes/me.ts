import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { rateLimitByUser } from '../middleware/rate-limit.js';
import { UpdateMeSchema, UpdateTemplateSchema } from '../schemas/profile.js';
import {
  ensureProfile,
  getAssembledUser,
  invalidateShortCodeCache,
  isKnownTemplateId,
  KNOWN_TEMPLATE_IDS,
  ProfileNotFoundError,
  regenerateShortCode,
  saveAssembledUser,
  setActiveTemplate,
} from '../services/profile.js';
import {
  ALLOWED_AVATAR_MIME_TYPES,
  ALLOWED_COVER_MIME_TYPES,
  ALLOWED_CV_MIME_TYPES,
  MAX_AVATAR_BYTES,
  MAX_COVER_BYTES,
  MAX_CV_BYTES,
  StorageError,
  cvMimeToExt,
  deleteAvatar,
  deleteCover,
  deleteCv,
  downloadCvBytes,
  uploadAvatar,
  uploadCover,
  uploadCv,
} from '../lib/storage.js';
import { CvParseError, parseCv } from '../services/cv-parse.js';
import { GeminiNotConfiguredError } from '../env.js';
import { getDb } from '../lib/db.js';
import { profiles } from '../db/schema.js';

/**
 * /v1/me — operations on the currently authenticated user's profile.
 *
 * Rate-limit policy
 * -----------------
 *  GET /v1/me  — 120 req/min/user. The frontend fetches this exactly once
 *                per session today, so the only legitimate way to hit this
 *                ceiling is a misbehaving client (retry storm, useEffect
 *                in a loop). We still want the ceiling — that's what
 *                catches the broken client before it floods our logs.
 *
 *  PUT /v1/me  — 20 req/min/user. The save button is debounced in the UI
 *                and a real user can't legitimately save 20+ times per
 *                minute. This protects the DB transaction (delete + bulk
 *                insert across 7 child tables) from being hammered.
 */
export const meRoutes = new Hono<{ Variables: AuthVariables }>();

meRoutes.use('*', requireAuth);

const readLimiter = rateLimitByUser({
  scope: 'me.read',
  limit: 120,
  windowMs: 60_000,
});

const writeLimiter = rateLimitByUser({
  scope: 'me.write',
  limit: 20,
  windowMs: 60_000,
});

// Avatar uploads are heavier (file I/O + Storage round-trip) so we want a
// tighter limit than the regular write path. 10/min easily handles a user
// who's iterating on their avatar choice; anything faster than that is a
// loop or an attack.
const avatarLimiter = rateLimitByUser({
  scope: 'me.avatar',
  limit: 10,
  windowMs: 60_000,
});

// Same shape as the avatar limiter — separate scope so a user iterating on
// their cover can't burn through the avatar budget (or vice versa).
const coverLimiter = rateLimitByUser({
  scope: 'me.cover',
  limit: 10,
  windowMs: 60_000,
});

// CV uploads are heavier still (4 MB files, Storage round-trip). 10/hour
// is well above any legitimate user need (uploading once, maybe once
// more after spotting a typo) and well below anything that could OOM
// the function.
const cvUploadLimiter = rateLimitByUser({
  scope: 'me.cv.upload',
  limit: 10,
  windowMs: 60 * 60_000,
});

// Parse calls are by far the most expensive request in the system — each
// one runs:
//   - storage read of the CV bytes
//   - PDF/DOCX text extraction
//   - Gemini API call (1 input token ≈ 4 chars; a typical CV is ~2K-8K
//     input tokens + ~1K output tokens)
//
// Gemini's free tier is 1500 req/day across the whole project. 20/hour
// per user gives plenty of headroom for testing without letting a single
// user burn the whole daily budget if they leave a tab open.
//
// We override `userMessage` because users (very reasonably) confuse OUR
// 429 with Gemini's quota — the error message has to make ownership
// obvious or we get bug reports about Google's dashboard "lying".
const cvParseLimiter = rateLimitByUser({
  scope: 'me.cv.parse',
  limit: 20,
  windowMs: 60 * 60_000,
  userMessage:
    "You've reached our per-user limit of 20 AI parses per hour. " +
    "(This is the Spotlight backend's limit, not Gemini's.)",
});

/**
 * Pull email/name out of the verified JWT so we can self-heal a missing
 * `profiles` row. Supabase's signup trigger _usually_ creates this row,
 * but devs delete rows manually, triggers can be disabled, etc.
 */
const authProfileBootstrap = (c: { var: AuthVariables }) => ({
  userId: c.var.user.id,
  email: c.var.user.email ?? '',
  name: (c.var.user.raw.user_metadata?.name as string | undefined) ?? '',
});

meRoutes.get('/', readLimiter, async (c) => {
  // Phase-level timing so we can see in Vercel logs which step is slow when
  // a user reports lag. Log line shape:
  //   [me.get] ensure=12ms assemble=180ms total=193ms userId=...
  // Use process.hrtime.bigint() to avoid Date.now()'s 1ms granularity quirks
  // on Node's monotonic-but-rounded clock.
  const t0 = process.hrtime.bigint();

  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);
  const tEnsure = process.hrtime.bigint();

  const user = await getAssembledUser(bootstrap.userId);
  if (!user) {
    // ensureProfile didn't throw but the row still isn't visible — should be
    // impossible, but fail loudly if it happens.
    throw new HTTPException(500, { message: 'Profile creation failed' });
  }
  const tAssemble = process.hrtime.bigint();

  const ms = (a: bigint, b: bigint) => Number((b - a) / 1_000_000n);
  console.log(
    `[me.get] ensure=${ms(t0, tEnsure)}ms assemble=${ms(
      tEnsure,
      tAssemble,
    )}ms total=${ms(t0, tAssemble)}ms userId=${bootstrap.userId}`,
  );

  return c.json({ user });
});

meRoutes.put(
  '/',
  writeLimiter,
  zValidator('json', UpdateMeSchema, (result, c) => {
    if (!result.success) {
      // Log full diagnostic server-side. The client only sees a sanitized
      // "field => message" pair so we don't leak internal field names that
      // future schema changes might rename.
      console.error(
        '[validator] PUT /v1/me failed:\n' +
          z.prettifyError(result.error),
      );
      return c.json(
        {
          error: {
            code: 422,
            message: 'Validation failed',
            details: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
        422,
      );
    }
  }),
  async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);
  const input = c.req.valid('json');

  try {
    await saveAssembledUser(bootstrap.userId, input);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      throw new HTTPException(404, { message: 'Profile not found' });
    }
    throw err;
  }

  // Any profile change must invalidate the public-lookup cache so the
  // visitor at /p/<code> sees the new data on their very next request
  // instead of waiting up to TTL seconds for the entry to expire.
  // We don't await this — if Redis is slow it shouldn't slow down the
  // save response. Worst case, a viewer sees stale data for up to 60s.
  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user });
});

// ---------------------------------------------------------------------------
// Avatar (Phase 1.0 — Supabase Storage)
// ---------------------------------------------------------------------------
//
// POST   /v1/me/avatar — multipart upload, replaces existing avatar
// DELETE /v1/me/avatar — removes avatar from Storage AND clears DB field
//
// We don't expose a GET because the avatar URL is already part of the
// assembled User returned by GET /v1/me. Frontend just consumes that.
//
// Why a dedicated endpoint instead of overloading PUT /v1/me?
//  - File uploads need multipart/form-data, not JSON
//  - Atomic semantics: upload + DB update happen together or not at all
//  - Tighter rate limit (avatar uploads are heavy; profile saves are cheap)
//  - Lets the frontend show real upload progress without coupling to a
//    full profile-save round-trip
// ---------------------------------------------------------------------------

meRoutes.post('/avatar', avatarLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  // parseBody() returns the whole multipart payload. We only care about
  // the "file" field. Hono types this as string | File | (string|File)[].
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch (err) {
    console.error('[me.avatar] failed to parse multipart body', err);
    throw new HTTPException(400, { message: 'Invalid multipart body' });
  }

  const raw = body.file;
  const file = Array.isArray(raw) ? raw[0] : raw;
  if (!file || typeof file === 'string') {
    throw new HTTPException(400, {
      message: 'Missing "file" field in multipart body',
    });
  }

  // Fast pre-checks before we read the bytes into memory. The Storage helper
  // re-validates after upload but rejecting here keeps the function memory
  // footprint smaller for obvious oversized requests.
  if (file.size > MAX_AVATAR_BYTES) {
    throw new HTTPException(413, {
      message: `Avatar exceeds ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB limit.`,
    });
  }
  if (!ALLOWED_AVATAR_MIME_TYPES.includes(file.type)) {
    throw new HTTPException(415, {
      message: `Unsupported avatar type "${file.type}". Allowed: ${ALLOWED_AVATAR_MIME_TYPES.join(', ')}.`,
    });
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  let publicUrl: string;
  try {
    publicUrl = await uploadAvatar(bootstrap.userId, buffer, file.type);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 413 | 415 | 500, { message: err.message });
    }
    throw err;
  }

  // Update profile.avatar_url. We deliberately do NOT touch the dedicated
  // PUT /v1/me update path here — that endpoint has unsaved-changes
  // semantics on the frontend, and we don't want the avatar upload to
  // accidentally flush a half-edited form.
  await getDb()
    .update(profiles)
    .set({ avatarUrl: publicUrl, updatedAt: new Date() })
    .where(eq(profiles.userId, bootstrap.userId));

  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user, avatarUrl: publicUrl });
});

meRoutes.delete('/avatar', avatarLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  try {
    await deleteAvatar(bootstrap.userId);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 500, { message: err.message });
    }
    throw err;
  }

  await getDb()
    .update(profiles)
    .set({ avatarUrl: null, updatedAt: new Date() })
    .where(eq(profiles.userId, bootstrap.userId));

  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user });
});

// ---------------------------------------------------------------------------
// Cover (Phase 1.0b — Supabase Storage)
// ---------------------------------------------------------------------------
//
// Structurally identical to the avatar pair above. See that block for the
// "why a dedicated endpoint" reasoning — it applies one-for-one here.
//
// POST   /v1/me/cover — multipart upload, replaces existing cover
// DELETE /v1/me/cover — removes cover from Storage AND clears DB field
// ---------------------------------------------------------------------------

meRoutes.post('/cover', coverLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch (err) {
    console.error('[me.cover] failed to parse multipart body', err);
    throw new HTTPException(400, { message: 'Invalid multipart body' });
  }

  const raw = body.file;
  const file = Array.isArray(raw) ? raw[0] : raw;
  if (!file || typeof file === 'string') {
    throw new HTTPException(400, {
      message: 'Missing "file" field in multipart body',
    });
  }

  if (file.size > MAX_COVER_BYTES) {
    throw new HTTPException(413, {
      message: `Cover exceeds ${Math.round(MAX_COVER_BYTES / 1024 / 1024)} MB limit.`,
    });
  }
  if (!ALLOWED_COVER_MIME_TYPES.includes(file.type)) {
    throw new HTTPException(415, {
      message: `Unsupported cover type "${file.type}". Allowed: ${ALLOWED_COVER_MIME_TYPES.join(', ')}.`,
    });
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  let publicUrl: string;
  try {
    publicUrl = await uploadCover(bootstrap.userId, buffer, file.type);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 413 | 415 | 500, { message: err.message });
    }
    throw err;
  }

  // Same column-only update as avatar: do NOT route through PUT /v1/me, which
  // has unsaved-changes semantics on the frontend.
  await getDb()
    .update(profiles)
    .set({ coverUrl: publicUrl, updatedAt: new Date() })
    .where(eq(profiles.userId, bootstrap.userId));

  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user, coverUrl: publicUrl });
});

meRoutes.delete('/cover', coverLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  try {
    await deleteCover(bootstrap.userId);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 500, { message: err.message });
    }
    throw err;
  }

  await getDb()
    .update(profiles)
    .set({ coverUrl: null, updatedAt: new Date() })
    .where(eq(profiles.userId, bootstrap.userId));

  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user });
});

// ---------------------------------------------------------------------------
// CV upload + AI parse (Phase 1.2)
// ---------------------------------------------------------------------------
//
// Two-step flow:
//
//   1. POST /v1/me/cv          → multipart upload, stores file in private
//                                bucket, records metadata on profile.
//                                Returns the updated User.
//
//   2. POST /v1/me/cv/parse    → reads the uploaded file, extracts text,
//                                runs Gemini structured extraction.
//                                Returns the parsed JSON (without writing
//                                to profile — the frontend handles
//                                accept/reject + then PUTs /v1/me with
//                                whatever the user accepted).
//
//   3. DELETE /v1/me/cv        → remove from Storage AND clear DB fields.
//
// Why two endpoints instead of one?
//  - Parse is expensive and re-runnable. Decoupling means the UI can
//    re-extract from an already-uploaded file without re-uploading.
//  - Different rate limits apply (parse is much costlier than upload).
//  - Errors split cleanly: upload errors are about IO/storage,
//    parse errors are about extraction or AI.
//
// Why NOT auto-parse on upload?
//  - The user might just want to store their CV file for "Download CV"
//    on the public profile (Phase 2). Not every upload needs AI work.
//  - Auto-parse couples a tight, fast operation (upload) to a slow,
//    rate-limited one (parse); a failed parse would muddy the upload
//    success state.
// ---------------------------------------------------------------------------

meRoutes.post('/cv', cvUploadLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch (err) {
    console.error('[me.cv] failed to parse multipart body', err);
    throw new HTTPException(400, { message: 'Invalid multipart body' });
  }

  const raw = body.file;
  const file = Array.isArray(raw) ? raw[0] : raw;
  if (!file || typeof file === 'string') {
    throw new HTTPException(400, {
      message: 'Missing "file" field in multipart body',
    });
  }

  // Fast pre-checks before reading bytes into memory. Storage will
  // re-validate but rejecting here cuts the function's memory peak
  // for an obvious oversized request.
  if (file.size > MAX_CV_BYTES) {
    throw new HTTPException(413, {
      message: `CV exceeds ${Math.round(MAX_CV_BYTES / 1024 / 1024)} MB limit.`,
    });
  }
  if (!ALLOWED_CV_MIME_TYPES.includes(file.type)) {
    throw new HTTPException(415, {
      message: `Unsupported CV type "${file.type}". Allowed: PDF, DOCX.`,
    });
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  let uploaded: Awaited<ReturnType<typeof uploadCv>>;
  try {
    uploaded = await uploadCv(bootstrap.userId, buffer, file.type);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 413 | 415 | 500, { message: err.message });
    }
    throw err;
  }

  // Store the metadata on the profile so the frontend can render
  // "your CV is up to date" / "uploaded 2 days ago" etc. The signed
  // URL itself is short-lived so we DON'T store it; we mint fresh
  // ones on demand via a future GET /v1/me/cv/signed-url endpoint.
  //
  // Filename: prefer the original name (what the user sees in their
  // downloads folder), capped at 500 chars to fit the DB column.
  const originalName = (file.name ?? 'resume').slice(0, 500);

  await getDb()
    .update(profiles)
    .set({
      cvFileName: originalName,
      cvFileUrl: uploaded.path,
      cvFileSize: uploaded.size,
      cvFileType: uploaded.contentType,
      cvUploadedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, bootstrap.userId));

  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({
    user,
    cv: {
      fileName: originalName,
      fileSize: uploaded.size,
      fileType: uploaded.contentType,
      signedUrl: uploaded.signedUrl,
    },
  });
});

/**
 * POST /v1/me/cv/parse — read the user's stored CV and run AI extraction.
 *
 * Returns the structured profile JSON (matching the frontend Zod shape)
 * but does NOT write it. The frontend renders a diff UI; only fields
 * the user accepts are sent back via PUT /v1/me.
 *
 * Errors map to specific status codes so the frontend can render
 * tailored copy:
 *   - 404: no CV uploaded yet
 *   - 415: legacy .doc file (we can't extract text)
 *   - 422: CV had no extractable text (image-only PDF)
 *   - 429: hit Gemini quota or our per-user limit
 *   - 502: provider was transiently down
 *   - 503: Gemini key not configured on the server
 */
meRoutes.post('/cv/parse', cvParseLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  const t0 = process.hrtime.bigint();

  // Look up the stored CV metadata. We need the content-type so we
  // can pick the right extractor; we don't trust the filename's
  // extension because users sometimes paste-rename.
  const [row] = await getDb()
    .select({
      cvFileType: profiles.cvFileType,
      cvFileUrl: profiles.cvFileUrl,
    })
    .from(profiles)
    .where(eq(profiles.userId, bootstrap.userId))
    .limit(1);

  if (!row?.cvFileType) {
    throw new HTTPException(404, { message: 'No CV uploaded yet.' });
  }
  const ext = cvMimeToExt(row.cvFileType);
  if (!ext) {
    // Stored content-type isn't on our allow-list. Shouldn't happen
    // because upload validates, but defensive.
    throw new HTTPException(415, {
      message: 'Stored CV has an unsupported format. Please re-upload.',
    });
  }

  // Read bytes server-side via the service role (RLS bypassed).
  let bytes: Uint8Array | null;
  try {
    bytes = await downloadCvBytes(bootstrap.userId, ext);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(500, { message: err.message });
    }
    throw err;
  }
  if (!bytes) {
    // DB says we have a CV but the file's gone from Storage. Should
    // be impossible (we don't have an orphan-cleanup path that does
    // this), but if it happens, surface a clean recovery instruction.
    throw new HTTPException(404, {
      message: 'CV file is missing from storage. Please re-upload.',
    });
  }
  const tDownload = process.hrtime.bigint();

  // Run the pipeline. CvParseError covers every expected failure mode;
  // anything else is a 500.
  let parsed: Awaited<ReturnType<typeof parseCv>>;
  try {
    parsed = await parseCv({ bytes, format: ext });
  } catch (err) {
    if (err instanceof GeminiNotConfiguredError) {
      throw new HTTPException(503, {
        message: 'AI parsing is not configured on this server.',
      });
    }
    if (err instanceof CvParseError) {
      throw new HTTPException(cvParseErrorStatus(err), { message: err.message });
    }
    throw err;
  }

  const tParse = process.hrtime.bigint();
  const ms = (a: bigint, b: bigint) => Number((b - a) / 1_000_000n);

  // Structured log so future cost-attribution dashboards can group by
  // user/model/usage. Don't log the actual CV text or extracted JSON —
  // that's PII.
  console.log(
    `[me.cv.parse] userId=${bootstrap.userId} model=${parsed.modelUsed}` +
      ` in=${parsed.usage.inputTokens}t out=${parsed.usage.outputTokens}t` +
      ` bytes=${parsed.inputBytes}${parsed.inputTruncated ? ' (truncated)' : ''}` +
      ` dl=${ms(t0, tDownload)}ms parse=${ms(tDownload, tParse)}ms total=${ms(t0, tParse)}ms`,
  );

  return c.json({
    extracted: parsed.data,
    meta: {
      modelUsed: parsed.modelUsed,
      usage: parsed.usage,
      inputTruncated: parsed.inputTruncated,
      inputBytes: parsed.inputBytes,
    },
  });
});

meRoutes.delete('/cv', cvUploadLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  try {
    await deleteCv(bootstrap.userId);
  } catch (err) {
    if (err instanceof StorageError) {
      throw new HTTPException(err.status as 500, { message: err.message });
    }
    throw err;
  }

  await getDb()
    .update(profiles)
    .set({
      cvFileName: null,
      cvFileUrl: null,
      cvFileSize: null,
      cvFileType: null,
      cvUploadedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, bootstrap.userId));

  void invalidateShortCodeCache(bootstrap.userId);

  const user = await getAssembledUser(bootstrap.userId);
  return c.json({ user });
});

/**
 * Map a CvParseError kind to an HTTP status. Kept as a function (not
 * a constant table) so TS will yell if a new kind is added without a
 * branch here.
 */
function cvParseErrorStatus(err: CvParseError): 415 | 422 | 429 | 500 | 502 {
  switch (err.kind) {
    case 'extractor-unsupported':
      return 415; // legacy .doc, etc.
    case 'extractor-no-text':
      return 422; // PDF was scan-only, no extractable text
    case 'llm-quota':
      return 429;
    case 'llm-policy':
      return 422; // safety filter — same UX as "we couldn't process this"
    case 'llm-transient':
      return 502;
    case 'extraction-failed':
    case 'llm-invalid':
    case 'llm-unknown':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Portfolio template (Phase 1.2)
// ---------------------------------------------------------------------------
//
// PUT /v1/me/portfolio { templateId } — set the user's active template.
//
// The public URL at /p/<short_code> renders whatever this row says. Users
// pick from the template gallery; clicking "Use this template" fires this.
//
// Why a dedicated route instead of folding into PUT /v1/me?
//   - Template selection from the gallery should NOT require the user's
//     full profile form to be in a "ready to save" state.
//   - The frontend treats this as a fire-and-forget action (with optimistic
//     UI); the full-profile PUT is a heavyweight transactional save.
//   - Tighter validation surface — only one field, only one error mode.
// ---------------------------------------------------------------------------

meRoutes.put(
  '/portfolio',
  writeLimiter,
  zValidator('json', UpdateTemplateSchema, (result, c) => {
    if (!result.success) {
      console.error(
        '[validator] PUT /v1/me/portfolio failed:\n' + z.prettifyError(result.error),
      );
      return c.json(
        {
          error: {
            code: 422,
            message: 'Validation failed',
            details: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
        422,
      );
    }
  }),
  async (c) => {
    const bootstrap = authProfileBootstrap(c);
    if (!bootstrap.email) {
      throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
    }
    await ensureProfile(bootstrap);

    const { templateId } = c.req.valid('json');

    // Allow-list check at the service-layer boundary, surfaced here as a
    // structured 422. We could push this into the Zod schema with
    // `z.enum(KNOWN_TEMPLATE_IDS)`, but keeping templates as a runtime
    // allow-list means adding a new template is a one-line code change
    // instead of a Zod-schema-plus-API-version coordination.
    if (!isKnownTemplateId(templateId)) {
      throw new HTTPException(422, {
        message: `Unknown templateId "${templateId}". Known: ${KNOWN_TEMPLATE_IDS.join(', ')}.`,
      });
    }

    const { shortCode, updatedAt } = await setActiveTemplate(bootstrap.userId, templateId);

    // Template change is visible at /p/<code>, so invalidate the cache.
    void invalidateShortCodeCache(bootstrap.userId);

    return c.json({
      portfolio: {
        templateId,
        shortCode,
        updatedAt: updatedAt.toISOString(),
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Short link (Phase 1.2)
// ---------------------------------------------------------------------------
//
// POST /v1/me/share-link/regenerate — issue a NEW short code, retiring
// the previous one. Useful when the user wants to rotate a link they've
// already shared (e.g. portfolio went under refresh, want the old URL
// to 404).
//
// Rate-limited tighter than other writes: each call mints a fresh code
// and invalidates cache, both of which are cheap individually but
// pointless to repeat. 5/min is well above any legitimate use.
// ---------------------------------------------------------------------------

const regenerateLimiter = rateLimitByUser({
  scope: 'me.share-link.regenerate',
  limit: 5,
  windowMs: 60_000,
});

meRoutes.post('/share-link/regenerate', regenerateLimiter, async (c) => {
  const bootstrap = authProfileBootstrap(c);
  if (!bootstrap.email) {
    throw new HTTPException(400, { message: 'Auth token is missing an email claim' });
  }
  await ensureProfile(bootstrap);

  // `regenerateShortCode` handles cache eviction of the OLD code
  // internally because it has the previous value in hand and we don't
  // want to read it twice.
  const { shortCode, updatedAt } = await regenerateShortCode(bootstrap.userId);

  return c.json({
    shortCode,
    updatedAt: updatedAt.toISOString(),
  });
});
