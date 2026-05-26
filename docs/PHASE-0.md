# Phase 0 — From localStorage demo to production foundation

This walkthrough takes the repo from "single-page demo that persists in
localStorage" to "frontend on Vercel + Hono backend on Vercel + Postgres on
Supabase, with real auth and RLS". Everything runs on free tiers; no domain or
credit card required.

When this guide is finished you'll have:

- A Supabase project with the schema applied (Drizzle + RLS SQL).
- Local dev for both the frontend (Vite) and backend (Hono) talking to Supabase.
- Sign-up / sign-in via Supabase Auth, profile saved to Postgres, served by Hono.
- Two Vercel projects (frontend + backend), ready to deploy on every push.
- CI on GitHub Actions running lint + typecheck on every PR.

The order matters — skip ahead at your own risk.

---

## 0. Prereqs

- Node 20.9+ (check with `node -v`)
- A free [GitHub](https://github.com) account
- A free [Supabase](https://supabase.com/dashboard) account
- A free [Vercel](https://vercel.com) account, connected to your GitHub
- **spotlight-portfolio** (frontend) and **Spotlight-backend** (API) as **sibling folders** under the same parent directory (e.g. `OneDrive - AMDOCS/`)

> **OneDrive tip (Windows):** Vite's dep cache (`node_modules/.vite`) sometimes
> fights with OneDrive's file watcher. If `npm run dev` ever errors with
> `EPERM: operation not permitted, rmdir`, just delete
> `node_modules\.vite` and try again.

---

## 1. Create a Supabase project (free tier)

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Choose any name, generate a strong DB password, pick a region close to you.
3. Wait ~2 minutes for the project to provision.
4. From **Project Settings → API**, grab:
   - **Project URL** → `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - **anon public** key → `VITE_SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (server only — never ship to the browser)
5. From **Project Settings → Database → Connection string → URI (Pooler, Transaction)**:
   - Copy the connection string → `DATABASE_URL`
   - Make sure it uses the **transaction pooler** (port `6543`). The backend's
     Drizzle client is tuned for that.

Keep this tab open — you'll paste these into `.env.local` files next.

---

## 2. Wire up local env vars

Create `.env.local` in the **spotlight-portfolio** repo (frontend):

```bash
# spotlight-portfolio/.env.local
VITE_API_URL=http://localhost:8787
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=ey...
```

And `.env` in the **Spotlight-backend** repo:

```bash
# Spotlight-backend/.env
PORT=8787
NODE_ENV=development
CORS_ORIGINS=http://localhost:5173

SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=ey...
SUPABASE_SERVICE_ROLE_KEY=ey...    # service_role from Supabase dashboard

DATABASE_URL=postgresql://postgres.<project-ref>:<DB_PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

`.env*` is in `.gitignore` for both apps. Never commit these files.

---

## 3. Apply the schema to Supabase

Two-step migration: Drizzle creates the tables, then a small SQL script wires
those tables into Supabase Auth and enables Row-Level Security.

### 3a. Drizzle (tables, columns, indexes)

```bash
cd Spotlight-backend   # sibling of spotlight-portfolio, or your backend clone
npm install
npm run db:generate   # generates SQL from src/db/schema.ts -> ./drizzle
npm run db:migrate    # applies the migration to Supabase
```

This creates `public.profiles`, `public.skills`, `public.experiences`,
`public.educations`, `public.projects`, `public.certifications`,
`public.achievements`, `public.languages`, and `public.portfolios`.

### 3b. Supabase-specific SQL (auth link + RLS policies)

The link to `auth.users`, the auto-create-profile trigger, the
`updated_at` triggers, and the RLS policies live in plain SQL because they
reference the Supabase-managed `auth` schema. Apply them once:

1. Open Supabase dashboard → **SQL Editor → New query**.
2. Paste the contents of `supabase/migrations/0001_auth_link_and_rls.sql`.
3. Hit **Run**.

After this, **every new `auth.users` row automatically creates a matching
`public.profiles` row**, and RLS enforces per-user access at the database
level.

> Want to inspect what got created? `npm run db:studio` opens Drizzle Studio
> against your Supabase DB.

---

## 4. Run both apps locally

In one terminal (frontend — `spotlight-portfolio`):

```bash
cd spotlight-portfolio
npm install
npm run dev
# -> Vite dev server on http://localhost:5173
```

In a second terminal (backend — sibling `Spotlight-backend`):

```bash
cd ../Spotlight-backend
npm install
npm run dev
# -> Hono on http://localhost:8787
```

Sanity check the backend:

```bash
curl http://localhost:8787/health
# { "status": "ok", "env": "development", ... }
```

Open the frontend. Sign up via the form (it now hits Supabase Auth, not
localStorage). On first login the `auth.users` trigger creates a row in
`public.profiles`, and the `useProfile` hook fetches it from `/v1/me`.

If you see the **Spotlight needs to be configured** screen instead of the
home page, the `VITE_SUPABASE_*` vars are missing — restart the dev server
after editing `.env.local`.

---

## 5. Deploy to Vercel

You'll create **two** Vercel projects from **two** GitHub repos:
**spotlight-portfolio** (frontend) and **Spotlight-backend** (API).

### 5a. Push to GitHub

- Frontend: push from `spotlight-portfolio` (existing repo).
- Backend: `git init` in `Spotlight-backend`, add remote, push to a new repo.

### 5b. Frontend project on Vercel

1. Vercel dashboard → **Add New… → Project** → import **spotlight-portfolio**.
2. **Root Directory:** `.` (repo root — default).
3. **Framework Preset:** Vite (auto-detected via `vercel.json`).
4. **Environment Variables:**
   - `VITE_API_URL` = the URL of your backend Vercel project (filled in after 5c)
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Deploy. After the first deploy, come back and update `VITE_API_URL`.

### 5c. Backend project on Vercel

1. Vercel dashboard → **Add New… → Project** → import **Spotlight-backend**.
2. **Root Directory:** `.` (repo root — default).
3. **Framework Preset:** Other (`vercel.json` describes the rest).
4. **Environment Variables:**
   - `NODE_ENV` = `production`
   - `CORS_ORIGINS` = `https://<your-frontend>.vercel.app`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `DATABASE_URL`
5. Deploy. Copy the resulting URL (e.g. `https://spotlight-api.vercel.app`).
6. Go back to the frontend project, set `VITE_API_URL` to that URL, and
   redeploy the frontend.

> **Why two projects?** Vercel's free Hobby plan gives both a generous static
> CDN allowance and serverless function budget. Splitting frontend (static) from
> backend (serverless) keeps them independent and easy to scale later.

---

## 6. CI

Each repo has its own `.github/workflows/ci.yml`:

- **spotlight-portfolio:** `npm ci`, ESLint, `tsc --noEmit`, `npm run build`
- **Spotlight-backend:** `npm ci`, `npm run lint`, `npm run typecheck`

Lint warnings don't fail the frontend build today (`--max-warnings=999`).

---

## 6.5. Email delivery — escape the built-in 2/hr cap

Supabase's built-in email service is **rate-limited to ~2 emails per hour per
project** on the free tier. That's fine for the first few signups but instantly
becomes a blocker once you start testing flows in earnest.

The fix: plug in a real SMTP provider. **Resend** is the recommended default
(3,000 emails/month forever, no time limit, best-in-class API).

### Steps to wire Resend into Supabase

1. Sign up at <https://resend.com> (no card required).
2. For local testing: use the built-in `onboarding@resend.dev` test sender — no
   domain needed. For production: **Domains → Add Domain** → add the DNS records
   Resend shows you (TXT + DKIM CNAMEs) at your registrar → wait for verification.
3. **API Keys → Create API Key**, copy the value.
4. In the Supabase dashboard → **Authentication → Emails → SMTP Settings** →
   toggle **Enable Custom SMTP**, and fill in:
   - Host: `smtp.resend.com`
   - Port: `465` (TLS)
   - Username: `resend`
   - Password: *your Resend API key*
   - Sender email: `onboarding@resend.dev` (test) or `noreply@yourdomain.com` (prod)
   - Sender name: `Spotlight`
5. Save and trigger a fresh signup to confirm an email arrives.

### Alternatives to Resend, ranked by free-tier generosity

| Provider | Free quota | Notes |
| --- | --- | --- |
| Resend | 3,000/mo, 100/day | Best DX, recommended |
| Brevo | 300/day | Bigger, older brand |
| SendGrid | 100/day | Smaller free tier |
| MailerSend | 3,000/mo | Decent backup |
| AWS SES | 62,000/mo (from EC2) | Cheapest at scale, ugly to set up |
| Mailgun | ~5,000/mo for 30 days then pay | Free tier dramatically shrank in 2023 |

## 7. What's next

Phase 0 is the boring-but-critical foundation. Future phases (each its own
PR) will layer on:

- **Phase 1 — Public portfolios:** `/p/:username` route, `published` portfolios,
  read-only RLS path for anonymous visitors, OG tags + dynamic preview cards.
- **Phase 2 — Short URLs:** `short_links` table, `/r/:slug` redirects via the
  backend, custom-slug + reserved-word validation.
- **Phase 3 — CV upload + AI extraction:** Supabase Storage for uploads,
  background job (or Vercel function) to call an LLM and merge the parsed data
  into the user's profile (with diff preview before commit).
- **Phase 4 — AI "ask about this person" chat:** Embed the profile, store vectors
  in `pgvector`, expose a `/v1/ask` endpoint with rate-limiting.
- **Phase 5 — More templates + theming:** Theme tokens in `portfolios.themeData`
  jsonb, drag-and-drop section ordering.
- **Phase 6 — Observability:** Sentry on both apps (gated behind env vars), basic
  product analytics, Supabase log drains.

The architecture chosen in Phase 0 (Hono on Vercel + Supabase Postgres + RLS)
is the same one used by several production SaaS apps in this category — it
should comfortably take you to a few thousand users on the free tiers and
then scale linearly when you decide to upgrade.
