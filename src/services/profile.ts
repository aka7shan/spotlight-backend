import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import {
  achievements,
  certifications,
  educations,
  experiences,
  languages,
  profiles,
  projects,
  skills,
} from '../db/schema.js';
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
  createdAt: string;
  updatedAt: string;
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

export async function getAssembledUser(userId: string): Promise<AssembledUser | null> {
  const db = getDb();

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!profile) return null;

  const [skillRows, expRows, eduRows, projRows, certRows, achRows, langRows] = await Promise.all([
    db.select().from(skills).where(eq(skills.userId, userId)).orderBy(skills.position),
    db.select().from(experiences).where(eq(experiences.userId, userId)).orderBy(experiences.position_order),
    db.select().from(educations).where(eq(educations.userId, userId)).orderBy(educations.position_order),
    db.select().from(projects).where(eq(projects.userId, userId)).orderBy(projects.position_order),
    db.select().from(certifications).where(eq(certifications.userId, userId)).orderBy(certifications.position_order),
    db.select().from(achievements).where(eq(achievements.userId, userId)).orderBy(achievements.position_order),
    db.select().from(languages).where(eq(languages.userId, userId)).orderBy(languages.position_order),
  ]);

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
    if (input.skills) {
      await tx.delete(skills).where(eq(skills.userId, userId));
      if (input.skills.length > 0) {
        await tx.insert(skills).values(
          input.skills.map((name, position) => ({ userId, name, position })),
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
    if (input.languages) {
      await tx.delete(languages).where(eq(languages.userId, userId));
      if (input.languages.length > 0) {
        await tx.insert(languages).values(
          input.languages.map((l, position_order) => ({
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

export class ProfileNotFoundError extends Error {
  userId: string;
  constructor(userId: string) {
    super(`Profile not found for user ${userId}`);
    this.name = 'ProfileNotFoundError';
    this.userId = userId;
  }
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
