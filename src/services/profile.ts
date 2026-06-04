import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import {
  achievements,
  certifications,
  educations,
  experiences,
  languages,
  portfolios,
  profiles,
  projects,
  skills,
} from '../db/schema.js';
import { cacheKeys, getCache } from '../lib/cache.js';
import { generateShortCode } from '../lib/shortcode.js';
import type {
  AchievementInput,
  CertificationInput,
  EducationInput,
  ExperienceInput,
  LanguageInput,
  ProjectInput,
  UpdateMeInput,
} from '../schemas/profile.js';

/**
 * Frontend User shape — mirrors src/types/portfolio.ts on the React side.
 * Exported so the API contract is explicit.
 */
export interface AssembledUser {
  id: string;
  username: string;
  name: string;
  title?: string | null;
  email: string;
  phone?: string | null;
  location?: string | null;
  about?: string | null;
  avatar?: string | null;
  coverImage?: string | null;
  socialLinks?: Record<string, string | undefined> | null;
  cv?: {
    fileName?: string;
    fileUrl?: string;
    uploadDate?: string;
    fileSize?: number;
    fileType?: string;
  } | null;
  skills: string[];
  experience: ExperienceInput[];
  education: EducationInput[];
  projects: ProjectInput[];
  certifications: CertificationInput[];
  achievements: AchievementInput[];
  languages: LanguageInput[];
  /**
   * Phase 1.2: which portfolio template is the user's "active" one,
   * i.e. the one rendered at their public URL. Defaults to 'classic' if
   * the user has never picked. Always present in the response so the
   * frontend never has to handle "missing template" branching.
   */
  activeTemplate: string;
  /**
   * Phase 1.2: Base62 short code that addresses this user's public
   * portfolio at `/p/<shortCode>`. ALWAYS present on responses to
   * authenticated users — `ensureShortCode` runs lazily on first GET
   * /v1/me and backfills if missing. On anonymous lookups (via
   * `getAssembledUserByShortCode`) it's also populated because the
   * lookup is keyed by it.
   */
  shortCode: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_TEMPLATE_ID = 'classic';

/**
 * Allow-list of known templates. Matches the five components the frontend
 * has built (`ClassicPortfolio`, `ModernTechPortfolio`, etc.). Keeping it
 * here means the backend rejects an obviously-bogus templateId at write
 * time instead of letting it stick and surprising the renderer.
 *
 * Add new ids here when we add new template components.
 */
export const KNOWN_TEMPLATE_IDS = [
  'classic',
  'modern-tech',
  'creative',
  'minimalist',
  'corporate',
] as const;
export type KnownTemplateId = (typeof KNOWN_TEMPLATE_IDS)[number];

export function isKnownTemplateId(id: string): id is KnownTemplateId {
  return (KNOWN_TEMPLATE_IDS as readonly string[]).includes(id);
}

// Wire (frontend Zod enum) ↔ DB (Postgres pg_enum) bidirectional maps.
// The `satisfies` clauses make these maps a compile-time exhaustiveness
// check: if you add a new variant to either side, TS will flag the missing
// entry here. That's worth a lot — it's the kind of bug that ships silently
// until a user picks the new value and gets a 500.

type ProjectStatusWire = 'Completed' | 'In Progress' | 'Planned';
type ProjectStatusDb = 'completed' | 'in_progress' | 'planned';

const PROJECT_STATUS_TO_DB = {
  Completed: 'completed',
  'In Progress': 'in_progress',
  Planned: 'planned',
} as const satisfies Record<ProjectStatusWire, ProjectStatusDb>;

const PROJECT_STATUS_FROM_DB = {
  completed: 'Completed',
  in_progress: 'In Progress',
  planned: 'Planned',
} as const satisfies Record<ProjectStatusDb, ProjectStatusWire>;

type LanguageLevelWire =
  | 'Beginner'
  | 'Intermediate'
  | 'Advanced'
  | 'Fluent'
  | 'Native'
  | 'Expert';
type LanguageLevelDb =
  | 'beginner'
  | 'intermediate'
  | 'advanced'
  | 'fluent'
  | 'native'
  | 'expert';

const LANGUAGE_LEVEL_TO_DB = {
  Beginner: 'beginner',
  Intermediate: 'intermediate',
  Advanced: 'advanced',
  Fluent: 'fluent',
  Native: 'native',
  Expert: 'expert',
} as const satisfies Record<LanguageLevelWire, LanguageLevelDb>;

const LANGUAGE_LEVEL_FROM_DB = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  fluent: 'Fluent',
  native: 'Native',
  expert: 'Expert',
} as const satisfies Record<LanguageLevelDb, LanguageLevelWire>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Authenticated read: load the assembled user for the current session.
 *
 * Also opportunistically backfills the portfolio's `shortCode` if missing
 * — see `ensureShortCode` for why this happens here instead of at signup.
 * The extra write is gated on the cheapest possible "is it already
 * populated?" check, so cost is one boolean condition for the 99%
 * (already-populated) case.
 */
export async function getAssembledUser(userId: string): Promise<AssembledUser | null> {
  const profile = await loadProfileByUserId(userId);
  if (!profile) return null;
  // Ensure a short_code exists before we assemble so the response always
  // carries one. `ensureShortCode` is idempotent and short-circuits on
  // the common case where the value is already populated.
  await ensureShortCode(userId);
  return assembleFromProfileRow(profile);
}

/**
 * Public anonymous read: by short code, used by `GET /v1/p/:code`.
 *
 * Joins `portfolios` → `profiles` so we only need one round-trip for the
 * lookup itself; the assemble step then does the usual fan-out. Returns
 * null on miss; the caller turns that into a 404.
 *
 * Caching is *not* applied here — the route layer wraps this call with
 * the Redis short-code cache because that's where the ETag / response
 * shape decisions live.
 */
export async function getAssembledUserByShortCode(
  shortCode: string,
): Promise<AssembledUser | null> {
  const db = getDb();
  const [row] = await db
    .select({ userId: portfolios.userId })
    .from(portfolios)
    .where(eq(portfolios.shortCode, shortCode))
    .limit(1);
  if (!row) return null;
  const profile = await loadProfileByUserId(row.userId);
  return assembleFromProfileRow(profile);
}

type ProfileRow = Awaited<ReturnType<typeof loadProfileByUserId>>;

async function loadProfileByUserId(userId: string) {
  const db = getDb();
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return row ?? null;
}

async function assembleFromProfileRow(profile: ProfileRow): Promise<AssembledUser | null> {
  if (!profile) return null;
  const userId = profile.userId;
  const db = getDb();

  // Fan-out: every child table + the user's portfolio row (for activeTemplate + shortCode).
  // The portfolio query is a one-row LIMIT so the extra round-trip is cheap.
  const [skillRows, expRows, eduRows, projRows, certRows, achRows, langRows, portfolioRows] =
    await Promise.all([
      db.select().from(skills).where(eq(skills.userId, userId)).orderBy(skills.position),
      db.select().from(experiences).where(eq(experiences.userId, userId)).orderBy(experiences.position_order),
      db.select().from(educations).where(eq(educations.userId, userId)).orderBy(educations.position_order),
      db.select().from(projects).where(eq(projects.userId, userId)).orderBy(projects.position_order),
      db.select().from(certifications).where(eq(certifications.userId, userId)).orderBy(certifications.position_order),
      db.select().from(achievements).where(eq(achievements.userId, userId)).orderBy(achievements.position_order),
      db.select().from(languages).where(eq(languages.userId, userId)).orderBy(languages.position_order),
      db
        .select({ templateId: portfolios.templateId, shortCode: portfolios.shortCode })
        .from(portfolios)
        .where(eq(portfolios.userId, userId))
        .limit(1),
    ]);

  // Always resolve to a known template id. If the row has a stale/typo'd
  // value (shouldn't happen with the write-time guard but defensive coding
  // is cheap), fall back to the default instead of breaking the renderer.
  const rawTemplateId = portfolioRows[0]?.templateId ?? DEFAULT_TEMPLATE_ID;
  const activeTemplate: string = isKnownTemplateId(rawTemplateId)
    ? rawTemplateId
    : DEFAULT_TEMPLATE_ID;

  // Short code should always be present here because all read paths
  // (authenticated GET /v1/me, public /v1/p/:code) ensure it before
  // calling. The empty-string fallback is defensive in case someone
  // calls this directly without going through `ensureShortCode` — the
  // response shape stays valid and the frontend gets a tell-tale empty
  // string instead of `undefined` + a runtime TypeError.
  const shortCode = portfolioRows[0]?.shortCode ?? '';

  return {
    id: profile.userId,
    username: profile.username,
    name: profile.name,
    title: profile.title,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    about: profile.about,
    avatar: profile.avatarUrl,
    coverImage: profile.coverUrl,
    socialLinks: profile.socialLinks ?? null,
    cv: profile.cvFileName
      ? {
          fileName: profile.cvFileName ?? undefined,
          fileUrl: profile.cvFileUrl ?? undefined,
          uploadDate: profile.cvUploadedAt?.toISOString(),
          fileSize: profile.cvFileSize ?? undefined,
          fileType: profile.cvFileType ?? undefined,
        }
      : null,
    skills: skillRows.map((s) => s.name),
    experience: expRows.map((row) => ({
      position: row.position,
      company: row.company,
      startDate: row.startDate,
      endDate: row.endDate ?? undefined,
      isPresent: row.isPresent,
      description: row.description ?? '',
      location: row.location ?? '',
      skills: row.skills ?? undefined,
    })),
    education: eduRows.map((row) => ({
      degree: row.degree,
      institution: row.institution,
      startDate: row.startDate,
      endDate: row.endDate ?? undefined,
      isPresent: row.isPresent,
      gpa: row.gpa ?? '',
      description: row.description ?? undefined,
      achievements: row.achievements ?? undefined,
    })),
    projects: projRows.map((row) => ({
      name: row.name,
      description: row.description,
      tags: row.tags ?? [],
      image: row.imageUrl ?? '',
      link: row.link ?? '',
      githubLink: row.githubLink ?? '',
      status: PROJECT_STATUS_FROM_DB[row.status],
      startDate: row.startDate ?? undefined,
      endDate: row.endDate ?? undefined,
      role: row.role ?? '',
      technologies: row.technologies ?? undefined,
      achievements: row.achievements ?? undefined,
    })),
    certifications: certRows.map((row) => ({
      name: row.name,
      issuer: row.issuer,
      startDate: row.startDate,
      endDate: row.endDate ?? undefined,
      isPresent: row.isPresent,
      credentialId: row.credentialId ?? '',
      link: row.link ?? '',
      expiryDate: row.expiryDate ?? undefined,
    })),
    achievements: achRows.map((row) => ({
      title: row.title,
      description: row.description,
      startDate: row.startDate,
      organization: row.organization ?? '',
      link: row.link ?? '',
    })),
    languages: langRows.map((row) => ({
      name: row.name,
      level: LANGUAGE_LEVEL_FROM_DB[row.level],
      certification: row.certification ?? '',
    })),
    activeTemplate,
    shortCode,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * "Big save": replace the entire User payload in a single transaction.
 * Wipes the related arrays (skills/experiences/etc.) and re-inserts them.
 *
 * This is the simplest possible mapping for the frontend's current "save the
 * whole form at once" behavior. We can add granular endpoints later.
 *
 * NOTE: The `profiles` row must exist already — the Supabase trigger creates
 * it on signup. We return 404 from the route layer if it doesn't.
 */
export async function saveAssembledUser(userId: string, input: UpdateMeInput) {
  const db = getDb();

  return await db.transaction(async (tx) => {
    // 1. Update profile (only the columns we own).
    //
    // Semantics: `null` from the client means "leave field as-is" (the GET
    // response returns null for empty columns and the frontend round-trips
    // those values back to us). To explicitly *clear* a nullable column, send
    // an empty string — the `value || null` pattern below turns that into a
    // real NULL in the DB.
    //
    // We use `!= null` (loose) which is true only for non-null, non-undefined.
    // This is especially important for `name`, which is NOT NULL in the DB.
    const [updated] = await tx
      .update(profiles)
      .set({
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.title != null ? { title: input.title || null } : {}),
        ...(input.phone != null ? { phone: input.phone || null } : {}),
        ...(input.location != null ? { location: input.location || null } : {}),
        ...(input.about != null ? { about: input.about || null } : {}),
        ...(input.avatar != null ? { avatarUrl: input.avatar || null } : {}),
        ...(input.coverImage != null ? { coverUrl: input.coverImage || null } : {}),
        ...(input.socialLinks != null
          ? {
              // Drizzle's column type is stricter than our wire schema (no
              // `null` values inside the object). Strip out nulls so the DB
              // gets a tidy `{ key: "value" }` shape.
              socialLinks: Object.fromEntries(
                Object.entries(input.socialLinks).filter(
                  (entry): entry is [string, string] =>
                    entry[1] != null && entry[1] !== '',
                ),
              ),
            }
          : {}),
        ...(input.cv?.fileName != null ? { cvFileName: input.cv.fileName } : {}),
        ...(input.cv?.fileUrl != null ? { cvFileUrl: input.cv.fileUrl } : {}),
        ...(input.cv?.fileSize != null ? { cvFileSize: input.cv.fileSize } : {}),
        ...(input.cv?.fileType != null ? { cvFileType: input.cv.fileType } : {}),
        // Always bump updatedAt even when only related arrays change (skills,
        // experience, etc.). $onUpdate on the column is a safety net for any
        // future direct-update path; setting it explicitly here also ensures
        // Drizzle actually emits an UPDATE when the spreads above are all
        // empty (which would otherwise be a no-op).
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId))
      .returning({ userId: profiles.userId });

    if (!updated) {
      // Profile doesn't exist yet (signup trigger failed or first PUT before
      // SELECT). We don't auto-create here because we need username + email
      // which come from auth.users — the trigger handles that path.
      throw new ProfileNotFoundError(userId);
    }

    // 2. Replace skills
    //
    // The (user_id, name) unique index means duplicates in the same payload
    // would raise postgres error 23505 and roll back the entire transaction.
    // That's a noisy 500 for what's almost always a benign user mistake (or
    // an auto-suggest dropdown firing twice), so we silently dedupe here.
    // First occurrence wins to preserve user-controlled ordering.
    if (input.skills) {
      await tx.delete(skills).where(eq(skills.userId, userId));
      const dedupedSkills = dedupeKeepFirst(input.skills, (s) => s);
      if (dedupedSkills.length > 0) {
        await tx.insert(skills).values(
          dedupedSkills.map((name, position) => ({ userId, name, position })),
        );
      }
    }

    // 3. Replace experiences
    if (input.experience) {
      await tx.delete(experiences).where(eq(experiences.userId, userId));
      if (input.experience.length > 0) {
        await tx.insert(experiences).values(
          input.experience.map((e, position_order) => ({
            userId,
            position: e.position,
            company: e.company,
            location: e.location || null,
            // startDate is NOT NULL in the DB; the wire schema allows
            // null/undefined for forgiveness, so coerce to '' on write.
            startDate: e.startDate ?? '',
            endDate: e.endDate || null,
            isPresent: e.isPresent ?? false,
            description: e.description ?? '',
            skills: e.skills ?? null,
            position_order,
          })),
        );
      }
    }

    // 4. Replace educations
    if (input.education) {
      await tx.delete(educations).where(eq(educations.userId, userId));
      if (input.education.length > 0) {
        await tx.insert(educations).values(
          input.education.map((e, position_order) => ({
            userId,
            degree: e.degree,
            institution: e.institution,
            startDate: e.startDate ?? '',
            endDate: e.endDate || null,
            isPresent: e.isPresent ?? false,
            gpa: e.gpa || null,
            description: e.description || null,
            achievements: e.achievements ?? null,
            position_order,
          })),
        );
      }
    }

    // 5. Replace projects
    if (input.projects) {
      await tx.delete(projects).where(eq(projects.userId, userId));
      if (input.projects.length > 0) {
        await tx.insert(projects).values(
          input.projects.map((p, position_order) => ({
            userId,
            name: p.name,
            description: p.description ?? '',
            tags: p.tags ?? [],
            imageUrl: p.image || null,
            link: p.link || null,
            githubLink: p.githubLink || null,
            status: PROJECT_STATUS_TO_DB[p.status],
            role: p.role || null,
            technologies: p.technologies ?? null,
            achievements: p.achievements ?? null,
            startDate: p.startDate || null,
            endDate: p.endDate || null,
            position_order,
          })),
        );
      }
    }

    // 6. Replace certifications
    if (input.certifications) {
      await tx.delete(certifications).where(eq(certifications.userId, userId));
      if (input.certifications.length > 0) {
        await tx.insert(certifications).values(
          input.certifications.map((c, position_order) => ({
            userId,
            name: c.name,
            issuer: c.issuer,
            startDate: c.startDate ?? '',
            endDate: c.endDate || null,
            isPresent: c.isPresent ?? false,
            credentialId: c.credentialId || null,
            link: c.link || null,
            expiryDate: c.expiryDate || null,
            position_order,
          })),
        );
      }
    }

    // 7. Replace achievements
    if (input.achievements) {
      await tx.delete(achievements).where(eq(achievements.userId, userId));
      if (input.achievements.length > 0) {
        await tx.insert(achievements).values(
          input.achievements.map((a, position_order) => ({
            userId,
            title: a.title,
            description: a.description ?? '',
            startDate: a.startDate ?? '',
            organization: a.organization || null,
            link: a.link || null,
            position_order,
          })),
        );
      }
    }

    // 8. Replace languages
    //
    // Same story as skills — (user_id, name) is a unique index. If the user
    // accidentally lists "English" twice (e.g. one at Beginner, one at
    // Advanced, intent unclear), we keep the LAST entry so an "I want to
    // upgrade my level" intent isn't silently ignored.
    if (input.languages) {
      await tx.delete(languages).where(eq(languages.userId, userId));
      const dedupedLanguages = dedupeKeepLast(input.languages, (l) => l.name);
      if (dedupedLanguages.length > 0) {
        await tx.insert(languages).values(
          dedupedLanguages.map((l, position_order) => ({
            userId,
            name: l.name,
            level: LANGUAGE_LEVEL_TO_DB[l.level],
            certification: l.certification || null,
            position_order,
          })),
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------
//
// Both arrays we save (skills, languages) sit behind unique indexes. The
// strategies differ:
//   - skills: identity ⇒ first wins, preserves user-controlled ordering
//   - languages: by name ⇒ last wins, so "I want to update my level"
//     intent is honored

function dedupeKeepFirst<T>(arr: readonly T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = getKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function dedupeKeepLast<T>(arr: readonly T[], getKey: (item: T) => string): T[] {
  // Map preserves insertion order; setting an existing key keeps it in
  // place but updates the value to the latest entry.
  const map = new Map<string, T>();
  for (const item of arr) {
    map.set(getKey(item), item);
  }
  return Array.from(map.values());
}

export class ProfileNotFoundError extends Error {
  userId: string;
  constructor(userId: string) {
    super(`Profile not found for user ${userId}`);
    this.name = 'ProfileNotFoundError';
    this.userId = userId;
  }
}

// ---------------------------------------------------------------------------
// Phase 1.2 — portfolio template + short-code operations
// ---------------------------------------------------------------------------

/**
 * Set (or insert) the user's active portfolio template.
 *
 * The public URL renders whatever this row says. Users pick from the
 * template gallery; clicking "Use This Template" calls this.
 *
 * Schema note: portfolios.slug is NOT NULL but otherwise unused — we
 * hard-code 'default' as the slug on insert. The `(user_id, slug)` unique
 * index still prevents duplicate rows per user, and changing this when we
 * add multiple-portfolios-per-user later is a separate migration.
 *
 * Side effect: the row's `updatedAt` bumps, which invalidates the public
 * short-code cache (we delete the cache key by short code at the route
 * layer after this returns).
 *
 * Caller MUST have validated `templateId` against KNOWN_TEMPLATE_IDS.
 */
export async function setActiveTemplate(
  userId: string,
  templateId: string,
): Promise<{ templateId: string; shortCode: string; updatedAt: Date }> {
  const db = getDb();

  // Try update first (common case: row already exists from a previous selection).
  const updated = await db
    .update(portfolios)
    .set({ templateId, updatedAt: new Date() })
    .where(eq(portfolios.userId, userId))
    .returning({
      templateId: portfolios.templateId,
      shortCode: portfolios.shortCode,
      updatedAt: portfolios.updatedAt,
    });
  if (updated.length > 0) {
    const row = updated[0]!;
    // Backfill short code if this is a legacy row created before Phase 1.2.
    // Doing it here keeps the API contract honest: callers always get a
    // non-empty short code in the response.
    const shortCode = row.shortCode ?? (await ensureShortCode(userId));
    return { templateId: row.templateId, shortCode, updatedAt: row.updatedAt };
  }

  // No row yet — insert one. This is the path a new user takes the first
  // time they pick a template (the signup trigger creates `profiles` but
  // not `portfolios`). Mint a short code in the same insert so we don't
  // need a follow-up UPDATE.
  const shortCode = await mintUniqueShortCode();
  const inserted = await db
    .insert(portfolios)
    .values({
      userId,
      slug: 'default',
      templateId,
      shortCode,
      isPublished: true,
      publishedAt: new Date(),
    })
    .returning({
      templateId: portfolios.templateId,
      shortCode: portfolios.shortCode,
      updatedAt: portfolios.updatedAt,
    });
  const row = inserted[0]!;
  return {
    templateId: row.templateId,
    shortCode: row.shortCode ?? shortCode,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Short-code lifecycle
// ---------------------------------------------------------------------------

/**
 * Maximum number of generation attempts before we give up. With a 7-char
 * Base62 alphabet (≈3.5 trillion addresses) the collision probability
 * after a million issued codes is still vanishingly small, so the loop
 * will essentially never re-enter. We cap iterations as a safety net so a
 * misconfigured DB (e.g. unique index missing) doesn't spin forever.
 */
const MAX_SHORT_CODE_RETRIES = 8;

/**
 * Generate a Base62 short code and confirm uniqueness against the DB.
 *
 * Why a probe-then-insert pattern instead of relying on the unique
 * constraint to surface a collision?
 * ----------------------------------
 * Two reasons:
 *   1. The function is called in contexts where we *don't* yet know
 *      which row will eventually carry the value (e.g. ensureShortCode
 *      generates the code first, then atomically slots it into an
 *      already-existing row). Letting the constraint reject the value
 *      forces us to wrap the whole insert/update in a retry loop,
 *      complicating the upstream callsites.
 *   2. A "probe" hits Postgres' unique index directly (an index-only
 *      scan), so the cost is one btree descent (≈microseconds), not a
 *      full insert + rollback.
 *
 * Race condition note
 * -------------------
 * Two concurrent callers *could* probe the same code, both see "not
 * taken", and one of them then fails on insert. We handle that case at
 * the actual insert/update sites by catching 23505 and retrying — see
 * `ensureShortCode` below.
 */
async function mintUniqueShortCode(): Promise<string> {
  const db = getDb();

  for (let i = 0; i < MAX_SHORT_CODE_RETRIES; i++) {
    const candidate = generateShortCode();
    const [hit] = await db
      .select({ shortCode: portfolios.shortCode })
      .from(portfolios)
      .where(eq(portfolios.shortCode, candidate))
      .limit(1);
    if (!hit) return candidate;
  }

  throw new Error(
    `Failed to mint a unique short code after ${MAX_SHORT_CODE_RETRIES} attempts. ` +
      'Check that the partial unique index on portfolios.short_code exists, and ' +
      'consider growing SHORT_CODE_LENGTH if the address space is genuinely exhausted.',
  );
}

/**
 * Ensure the calling user has a portfolio row with a populated short code.
 * Returns the code.
 *
 * Three cases:
 *   1. Row exists with a code → return it (fast path, one SELECT).
 *   2. Row exists without a code (legacy) → UPDATE with a fresh code.
 *   3. No row at all → INSERT with default template + fresh code.
 *
 * Cases 2 and 3 race-recover via the unique-violation catch: if another
 * concurrent request inserted/updated first, we re-read and use the
 * winner's code. This keeps the contract idempotent under bursty load
 * (e.g. an SPA firing two GETs in quick succession at login).
 */
export async function ensureShortCode(userId: string): Promise<string> {
  const db = getDb();

  for (let attempt = 0; attempt < MAX_SHORT_CODE_RETRIES; attempt++) {
    const [existing] = await db
      .select({ shortCode: portfolios.shortCode })
      .from(portfolios)
      .where(eq(portfolios.userId, userId))
      .limit(1);

    // Case 1: row + code present. Done.
    if (existing?.shortCode) return existing.shortCode;

    const candidate = await mintUniqueShortCode();

    try {
      // Case 2: row exists but code is null. UPDATE.
      if (existing) {
        const [updated] = await db
          .update(portfolios)
          .set({ shortCode: candidate, updatedAt: new Date() })
          .where(eq(portfolios.userId, userId))
          .returning({ shortCode: portfolios.shortCode });
        if (updated?.shortCode) return updated.shortCode;
        // Fell through (shouldn't happen unless the row was deleted
        // mid-flight). Retry.
        continue;
      }

      // Case 3: no row at all. INSERT with sensible defaults.
      const [inserted] = await db
        .insert(portfolios)
        .values({
          userId,
          slug: 'default',
          shortCode: candidate,
          templateId: DEFAULT_TEMPLATE_ID,
          isPublished: true,
          publishedAt: new Date(),
        })
        .returning({ shortCode: portfolios.shortCode });
      if (inserted?.shortCode) return inserted.shortCode;
    } catch (err) {
      // 23505 = unique_violation. Either another request beat us to the
      // INSERT (case 3) or our candidate collided with another row's
      // newly-claimed code (case 2). Both resolve the same way: loop
      // and re-read.
      const code = (err as { code?: string })?.code;
      if (code === '23505') continue;
      throw err;
    }
  }

  throw new Error(
    `Failed to ensure short code for user ${userId} after ${MAX_SHORT_CODE_RETRIES} attempts.`,
  );
}

/**
 * Issue a brand-new short code for the user's portfolio, retiring the
 * old one. The previous short code stops working immediately at the DB
 * layer; we also explicitly invalidate the Redis cache entry so cached
 * lookups for the old code start hitting the (now-empty) DB and miss.
 *
 * Use case: user posted their link to LinkedIn but later wants to
 * "rotate" it (e.g. after taking the portfolio down for a refresh).
 *
 * Returns the new code and the row's new updatedAt (useful for ETag).
 */
export async function regenerateShortCode(
  userId: string,
): Promise<{ shortCode: string; updatedAt: Date }> {
  const db = getDb();
  const cache = getCache();

  // First read the existing code so we know what to evict from cache.
  const [existing] = await db
    .select({ shortCode: portfolios.shortCode })
    .from(portfolios)
    .where(eq(portfolios.userId, userId))
    .limit(1);

  for (let attempt = 0; attempt < MAX_SHORT_CODE_RETRIES; attempt++) {
    const candidate = await mintUniqueShortCode();

    try {
      // Update the existing row if present, otherwise insert a new
      // default portfolio with the new code. Both paths converge on
      // the same return shape.
      if (existing) {
        const [updated] = await db
          .update(portfolios)
          .set({ shortCode: candidate, updatedAt: new Date() })
          .where(eq(portfolios.userId, userId))
          .returning({ shortCode: portfolios.shortCode, updatedAt: portfolios.updatedAt });
        if (!updated?.shortCode) continue;
        // Evict the old key so the next anonymous lookup correctly 404s.
        if (existing.shortCode) {
          await cache.del(cacheKeys.shortCode(existing.shortCode));
        }
        return { shortCode: updated.shortCode, updatedAt: updated.updatedAt };
      }

      const [inserted] = await db
        .insert(portfolios)
        .values({
          userId,
          slug: 'default',
          shortCode: candidate,
          templateId: DEFAULT_TEMPLATE_ID,
          isPublished: true,
          publishedAt: new Date(),
        })
        .returning({ shortCode: portfolios.shortCode, updatedAt: portfolios.updatedAt });
      if (inserted?.shortCode) {
        return { shortCode: inserted.shortCode, updatedAt: inserted.updatedAt };
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') continue;
      throw err;
    }
  }

  throw new Error(
    `Failed to regenerate short code for user ${userId} after ${MAX_SHORT_CODE_RETRIES} attempts.`,
  );
}

/**
 * Invalidate the public-lookup cache entry for a user's short code.
 * Call after any mutation that affects the assembled-user response
 * (saveAssembledUser, setActiveTemplate, avatar upload, etc.) so the
 * anonymous viewer sees fresh data instead of a 60s stale snapshot.
 *
 * Soft-fails by design: a missing row, a missing code, and a Redis hiccup
 * are all "ignore and move on". The TTL upper-bounds staleness anyway.
 */
export async function invalidateShortCodeCache(userId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({ shortCode: portfolios.shortCode })
    .from(portfolios)
    .where(eq(portfolios.userId, userId))
    .limit(1);
  if (!row?.shortCode) return;
  await getCache().del(cacheKeys.shortCode(row.shortCode));
}

// ---------------------------------------------------------------------------
// Self-heal: create the profiles row on demand
// ---------------------------------------------------------------------------

/**
 * Ensure a `profiles` row exists for the given user.
 *
 * Normally Supabase's `on_auth_user_created` trigger creates this row at signup
 * time. But there are real cases where we get here without a row:
 *   - The trigger wasn't installed yet when the user signed up.
 *   - The row was manually deleted (e.g. in dev / cleanup).
 *   - A race between the trigger and the first API call.
 *
 * Rather than 404 the user, we mirror the trigger's logic in app code: derive
 * a username from the email's local part, retry with random-ish suffixes on
 * unique-violation collisions.
 *
 * No-op if a row already exists.
 */
export async function ensureProfile(args: {
  userId: string;
  email: string;
  name?: string;
}): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.userId, args.userId))
    .limit(1);
  if (existing.length > 0) return;

  // Derive a candidate username. The DB has a CHECK constraint:
  //   ^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$
  // so we only emit lowercase alphanumerics + hyphens, 3-32 chars long.
  const localPart = args.email.split('@')[0] || 'user';
  const sanitized = localPart.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const base =
    sanitized.length >= 3 ? sanitized.slice(0, 24) : `user-${args.userId.replace(/-/g, '').slice(0, 8)}`;

  const compactId = args.userId.replace(/-/g, '');
  const candidates = [
    base,
    `${base}-${compactId.slice(0, 4)}`,
    `${base}-${compactId.slice(0, 6)}`,
    `${base}-${compactId.slice(0, 8)}`,
    // Final guaranteed-unique fallback
    `user-${compactId.slice(0, 12)}`,
  ];

  for (const username of candidates) {
    try {
      await db.insert(profiles).values({
        userId: args.userId,
        username,
        email: args.email,
        name: args.name ?? '',
      });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // 23505 = unique_violation (username collision). Try the next candidate.
      // Anything else (e.g. 23503 = foreign key violation on auth.users) bubbles
      // up — the caller almost certainly can't recover from it anyway.
      if (code !== '23505') throw err;
    }
  }

  throw new Error(`Could not generate a unique username for ${args.userId}`);
}
