/**
 * Drizzle schema for Spotlight Postgres (Supabase).
 *
 * Naming conventions
 * ------------------
 *  - All table names are plural snake_case (e.g. `experiences`).
 *  - All column names are snake_case in the DB but camelCase in TS
 *    (handled by the `casing: 'snake_case'` option in db.ts + drizzle.config).
 *  - Foreign keys cascade on delete from the parent record.
 *
 * Supabase Auth integration
 * -------------------------
 *  - Supabase manages an `auth.users` table for us.
 *  - We reference `auth.users.id` from our `public.profiles.user_id`.
 *  - On a real schema we'd `references(() => authUsers.id, { onDelete: 'cascade' })`,
 *    but since `auth.users` isn't managed by Drizzle we declare the FK in raw SQL
 *    in the migration instead (see drizzle/0000_*.sql RLS file).
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const planEnum = pgEnum('plan', ['free', 'pro', 'career']);

export const projectStatusEnum = pgEnum('project_status', [
  'completed',
  'in_progress',
  'planned',
]);

export const languageLevelEnum = pgEnum('language_level', [
  'beginner',
  'intermediate',
  'advanced',
  'fluent',
  'native',
  'expert',
]);

// ---------------------------------------------------------------------------
// Profiles (the canonical "user" record in our own schema)
// One row per Supabase auth.users row, linked 1:1 by user_id.
// ---------------------------------------------------------------------------

export const profiles = pgTable(
  'profiles',
  {
    // Mirrors auth.users.id (uuid). FK declared in migration SQL.
    userId: uuid('user_id').primaryKey(),

    // Public identity used in URLs: spotlight.app/u/<username>
    username: text('username').notNull(),

    // Display fields
    name: text('name').notNull().default(''),
    title: text('title'),
    email: text('email').notNull(),
    phone: text('phone'),
    location: text('location'),
    about: text('about'),
    avatarUrl: text('avatar_url'),
    coverUrl: text('cover_url'),

    // Social links — small enough to keep as jsonb
    socialLinks: jsonb('social_links').$type<{
      linkedin?: string;
      github?: string;
      twitter?: string;
      website?: string;
      dribbble?: string;
      behance?: string;
    }>(),

    // Plan / billing
    plan: planEnum('plan').notNull().default('free'),

    // CV upload — store reference, not the file itself (file lives in Supabase Storage)
    cvFileName: text('cv_file_name'),
    cvFileUrl: text('cv_file_url'),
    cvFileSize: bigint('cv_file_size', { mode: 'number' }),
    cvFileType: text('cv_file_type'),
    cvUploadedAt: timestamp('cv_uploaded_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // $onUpdate makes Drizzle stamp this column on every UPDATE statement it
    // emits. Without it the `default(now())` only fires on INSERT and the
    // column gets stuck at the row's creation time — which is what was
    // happening before.
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('profiles_username_uniq').on(t.username),
    check(
      'profiles_username_format',
      // 3-32 chars, lowercase letters/numbers/hyphens, no leading/trailing hyphen
      sql`${t.username} ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Skills — many flat tags per profile. We model as a separate table (vs jsonb
// array on profiles) so we can index, autocomplete, and aggregate later.
// ---------------------------------------------------------------------------

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category'), // optional grouping (e.g. "Frontend", "Soft skills")
    position: integer('position').notNull().default(0), // sort order
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('skills_user_idx').on(t.userId),
    uniqueIndex('skills_user_name_uniq').on(t.userId, t.name),
  ],
);

// ---------------------------------------------------------------------------
// Experiences (work history)
// ---------------------------------------------------------------------------

export const experiences = pgTable(
  'experiences',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    position: text('position').notNull(),
    company: text('company').notNull(),
    location: text('location'),

    startDate: text('start_date').notNull(), // ISO date or just "2021"
    endDate: text('end_date'),
    isPresent: boolean('is_present').notNull().default(false),

    description: text('description'),
    skills: text('skills').array(), // text[] — small set of skill tags scoped to this role

    position_order: integer('position_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('experiences_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Educations
// ---------------------------------------------------------------------------

export const educations = pgTable(
  'educations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    degree: text('degree').notNull(),
    institution: text('institution').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    isPresent: boolean('is_present').notNull().default(false),
    gpa: text('gpa'),
    description: text('description'),
    achievements: text('achievements').array(),

    position_order: integer('position_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('educations_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    imageUrl: text('image_url'),
    link: text('link'),
    githubLink: text('github_link'),
    status: projectStatusEnum('status').notNull().default('completed'),
    role: text('role'),
    technologies: text('technologies').array(),
    achievements: text('achievements').array(),

    startDate: text('start_date'),
    endDate: text('end_date'),

    position_order: integer('position_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('projects_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

export const certifications = pgTable(
  'certifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    issuer: text('issuer').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    isPresent: boolean('is_present').notNull().default(false),
    credentialId: text('credential_id'),
    link: text('link'),
    expiryDate: text('expiry_date'),

    position_order: integer('position_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('certifications_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export const achievements = pgTable(
  'achievements',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    startDate: text('start_date').notNull(),
    organization: text('organization'),
    link: text('link'),

    position_order: integer('position_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('achievements_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export const languages = pgTable(
  'languages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    level: languageLevelEnum('level').notNull(),
    certification: text('certification'),

    position_order: integer('position_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('languages_user_idx').on(t.userId),
    uniqueIndex('languages_user_name_uniq').on(t.userId, t.name),
  ],
);

// ---------------------------------------------------------------------------
// Portfolios (a user can have multiple, each pointing at a template)
// Phase 0 keeps it simple: one default portfolio per user, holding the
// selected template + any per-template overrides.
// ---------------------------------------------------------------------------

export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),

    slug: text('slug').notNull(), // unique per user (eg "default")
    templateId: text('template_id').notNull().default('classic'),
    themeOverrides: jsonb('theme_overrides').$type<Record<string, unknown>>(),
    isPublished: boolean('is_published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('portfolios_user_slug_uniq').on(t.userId, t.slug),
    index('portfolios_published_idx').on(t.isPublished, t.publishedAt),
  ],
);
