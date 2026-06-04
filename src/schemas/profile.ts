import { z } from 'zod';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROFILE VALIDATION CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Zod schemas that define the wire contract for `PUT /v1/me`.
 *
 *  This file is the **source of truth** for which fields are required and
 *  which are optional. The frontend mirrors this policy in
 *  `src/lib/validators/user.ts` so the Save button can short-circuit before
 *  hitting the network.
 *
 *  **If you change required-ness here, change it there too.**
 *
 *  Policy:
 *    Profile-level required        → name, title
 *    Profile-level optional        → phone, location, about, avatar, coverImage,
 *                                    socialLinks, cv (each accepts null)
 *    Skills                        → each string non-empty
 *    Experience (per entry)        → position, company, startDate
 *    Education (per entry)         → degree, institution, startDate
 *    Project (per entry)           → name
 *    Certification (per entry)     → name, issuer, startDate
 *    Achievement (per entry)       → title, startDate
 *    Language (per entry)          → name, level
 *
 *  All "date" fields are free-form text (we accept "2021", "Aug 2021",
 *  "2021-08-01", etc.) capped at 32 chars.
 */

// A non-empty, length-capped required string. Used wherever the policy says
// the field must be present.
const required = (max: number) => z.string().trim().min(1).max(max);

// Date fields are surprisingly fluid in the UI ("Aug 2021", "2021", "2021-08-01"),
// so we don't enforce a format here — only a sensible max length.
const requiredDate = required(32); // for fields the policy says are required
const optDate = z.string().max(32).nullish(); // for end dates etc.

// Free-form text used for non-required text fields like phone, location, etc.
// `.nullish()` accepts string | null | undefined — important because the DB
// stores NULL for unset fields and the frontend round-trips that back to us.
const optStr = z.string().max(2000).nullish();

// Links the UI accepts. We intentionally don't .url() these because real users
// type `github.com/foo` or `linkedin.com/in/bar` and we'd rather store the bare
// string than reject the save. The frontend normalizes for display.
const flexibleLink = z.string().max(2048).nullish();

// Image fields used by content that's still on the data-URL path (project
// thumbnails, etc.). Accepts:
//   - an http(s) URL (Unsplash sample data, Supabase Storage public URL)
//   - a `data:image/*;base64,...` URI (file upload via FileReader)
//   - an empty string (no image yet) or null (column unset in DB)
// 10MB cap keeps a runaway base64 blob from filling the request body indefinitely.
const flexibleImage = z.string().max(10_000_000).nullish();

// Strict URL field for content that's been migrated to Supabase Storage
// (Phase 1.0: avatar, cover image). Once everything is a URL we can drop
// flexibleImage entirely.
//
// We don't use .url() because some legitimate values are protocol-relative
// or relative paths (rare for our use case, but future-proofs). The 2 KB
// ceiling is generous: a normal Supabase public URL is < 200 chars.
const imageUrl = z.string().max(2048).nullish();

export const SocialLinksSchema = z
  .object({
    linkedin: flexibleLink,
    github: flexibleLink,
    twitter: flexibleLink,
    website: flexibleLink,
    dribbble: flexibleLink,
    behance: flexibleLink,
  })
  .partial()
  .nullish();

export const CvDataSchema = z
  .object({
    fileName: z.string().max(500).nullish(),
    fileUrl: flexibleLink,
    uploadDate: z.string().max(64).nullish(),
    fileSize: z.number().int().nonnegative().nullish(),
    fileType: z.string().max(200).nullish(),
  })
  .partial()
  .nullish();

export const ExperienceSchema = z.object({
  position: required(200),
  company: required(200),
  startDate: requiredDate,
  endDate: optDate,
  isPresent: z.boolean().default(false),
  description: z.string().max(5000).default(''),
  location: optStr,
  skills: z.array(z.string().max(80)).max(50).nullish(),
});

export const EducationSchema = z.object({
  degree: required(200),
  institution: required(200),
  startDate: requiredDate,
  endDate: optDate,
  isPresent: z.boolean().nullish(),
  gpa: optStr,
  description: z.string().max(5000).nullish(),
  achievements: z.array(z.string().max(500)).max(50).nullish(),
});

export const ProjectSchema = z.object({
  name: required(200),
  description: z.string().max(5000).default(''),
  tags: z.array(z.string().max(80)).max(50).default([]),
  image: flexibleImage,
  link: flexibleLink,
  githubLink: flexibleLink,
  status: z.enum(['Completed', 'In Progress', 'Planned']).default('Completed'),
  startDate: optDate,
  endDate: optDate,
  role: optStr,
  technologies: z.array(z.string().max(80)).max(50).nullish(),
  achievements: z.array(z.string().max(500)).max(50).nullish(),
});

export const CertificationSchema = z.object({
  name: required(200),
  issuer: required(200),
  startDate: requiredDate,
  endDate: optDate,
  isPresent: z.boolean().nullish(),
  credentialId: optStr,
  link: flexibleLink,
  expiryDate: optDate,
});

export const AchievementSchema = z.object({
  title: required(200),
  description: z.string().max(5000).default(''),
  startDate: requiredDate,
  organization: optStr,
  link: flexibleLink,
});

export const LanguageSchema = z.object({
  name: required(80),
  level: z.enum(['Beginner', 'Intermediate', 'Advanced', 'Fluent', 'Native', 'Expert']),
  certification: optStr,
});

/**
 * The full User PUT payload.
 * `id`, `email`, `username`, `createdAt`, `updatedAt` are managed by the
 * server and silently ignored if the client sends them.
 *
 * `name` and `title` are the **only** profile-level required fields.
 * Everything else is `.nullish()` so it accepts `null`/`undefined`/empty.
 *
 * Update semantics (PUT /v1/me)
 * -----------------------------
 *  Despite the HTTP verb, this endpoint behaves like a **patch** for scalar
 *  fields and a **replace** for array fields. Specifically:
 *
 *    Field is omitted / undefined / null  → keep existing value
 *    Field is empty string ('')           → clear (write SQL NULL)
 *    Field is a non-empty value           → overwrite
 *    Array is omitted / undefined         → keep existing array
 *    Array is provided ([] or [...])      → replace entire array (full wipe + insert)
 *
 *  The frontend round-trips whatever it loaded from GET /v1/me, so the
 *  "omit = keep" rule means clients don't lose data when they only edited
 *  one section. If you ever need a true PUT (full replace, missing = clear),
 *  add a separate endpoint instead of changing this one.
 */
export const UpdateMeSchema = z.object({
  name: required(200),
  title: required(200),

  phone: z.string().max(40).nullish(),
  location: z.string().max(200).nullish(),
  about: z.string().max(10000).nullish(),
  // avatar + coverImage have been migrated to Supabase Storage (Phase 1.0).
  // They're URLs now, never data URIs. The dedicated POST /v1/me/avatar
  // endpoint is the only path that writes to these — PUT /v1/me only
  // accepts the URL the upload route returned.
  avatar: imageUrl,
  coverImage: imageUrl,
  socialLinks: SocialLinksSchema,
  cv: CvDataSchema,

  // Skills are required to be non-empty strings *if* the array is provided.
  // (The array itself can be empty/null/absent.)
  skills: z.array(required(80)).max(100).nullish(),
  experience: z.array(ExperienceSchema).max(50).nullish(),
  education: z.array(EducationSchema).max(50).nullish(),
  projects: z.array(ProjectSchema).max(100).nullish(),
  certifications: z.array(CertificationSchema).max(100).nullish(),
  achievements: z.array(AchievementSchema).max(100).nullish(),
  languages: z.array(LanguageSchema).max(50).nullish(),
});

export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
export type ExperienceInput = z.infer<typeof ExperienceSchema>;
export type EducationInput = z.infer<typeof EducationSchema>;
export type ProjectInput = z.infer<typeof ProjectSchema>;
export type CertificationInput = z.infer<typeof CertificationSchema>;
export type AchievementInput = z.infer<typeof AchievementSchema>;
export type LanguageInput = z.infer<typeof LanguageSchema>;

// ---------------------------------------------------------------------------
// Phase 1.1 — share / public-username contract
// ---------------------------------------------------------------------------
//
// Zod validates the wire shape ONLY. Business rules (length, format, reserved
// words, uniqueness) live in src/lib/slug.ts and the service layer. Keeping
// the Zod-level check loose lets us return our own structured error codes
// from validateUsername() instead of generic 422 messages.

export const UpdateUsernameSchema = z.object({
  username: z.string().min(1).max(64),
});
export type UpdateUsernameInput = z.infer<typeof UpdateUsernameSchema>;

export const CheckUsernameQuerySchema = z.object({
  username: z.string().min(1).max(64),
});
