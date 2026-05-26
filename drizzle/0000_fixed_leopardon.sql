CREATE TYPE "public"."language_level" AS ENUM('beginner', 'intermediate', 'advanced', 'fluent', 'native', 'expert');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'pro', 'career');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('completed', 'in_progress', 'planned');--> statement-breakpoint
CREATE TABLE "achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"start_date" text NOT NULL,
	"organization" text,
	"link" text,
	"position_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"is_present" boolean DEFAULT false NOT NULL,
	"credential_id" text,
	"link" text,
	"expiry_date" text,
	"position_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "educations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"degree" text NOT NULL,
	"institution" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"is_present" boolean DEFAULT false NOT NULL,
	"gpa" text,
	"description" text,
	"achievements" text[],
	"position_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position" text NOT NULL,
	"company" text NOT NULL,
	"location" text,
	"start_date" text NOT NULL,
	"end_date" text,
	"is_present" boolean DEFAULT false NOT NULL,
	"description" text,
	"skills" text[],
	"position_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" "language_level" NOT NULL,
	"certification" text,
	"position_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"template_id" text DEFAULT 'classic' NOT NULL,
	"theme_overrides" jsonb,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"title" text,
	"email" text NOT NULL,
	"phone" text,
	"location" text,
	"about" text,
	"avatar_url" text,
	"cover_url" text,
	"social_links" jsonb,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"cv_file_name" text,
	"cv_file_url" text,
	"cv_file_size" bigint,
	"cv_file_type" text,
	"cv_uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_username_format" CHECK ("profiles"."username" ~ '^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_url" text,
	"link" text,
	"github_link" text,
	"status" "project_status" DEFAULT 'completed' NOT NULL,
	"role" text,
	"technologies" text[],
	"achievements" text[],
	"start_date" text,
	"end_date" text,
	"position_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "educations" ADD CONSTRAINT "educations_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "languages" ADD CONSTRAINT "languages_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "achievements_user_idx" ON "achievements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "certifications_user_idx" ON "certifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "educations_user_idx" ON "educations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "experiences_user_idx" ON "experiences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "languages_user_idx" ON "languages" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "languages_user_name_uniq" ON "languages" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_user_slug_uniq" ON "portfolios" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "portfolios_published_idx" ON "portfolios" USING btree ("is_published","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_username_uniq" ON "profiles" USING btree ("username");--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skills_user_idx" ON "skills" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_user_name_uniq" ON "skills" USING btree ("user_id","name");