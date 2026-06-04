# Spotlight Backend

Hono API for Spotlight Portfolio: JWT auth, profile CRUD, Postgres via Drizzle.

**Frontend repo (sibling folder):** `../spotlight-portfolio` on disk —  
[github.com/aka7shan/spotlight-portfolio](https://github.com/aka7shan/spotlight-portfolio)

```
Project
├── spotlight-portfolio/    ← frontend (existing Git)
└── Spotlight-backend/      ← this repo (new Git remote)
```

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
# -> http://localhost:8787/health
```

Run the frontend from `../spotlight-portfolio` (`npm run dev` on port 5173).
`CORS_ORIGINS` must include `http://localhost:5173`.

## Push to its own GitHub repo

```bash
git init
git add .
git commit -m "Initial Spotlight backend"
git branch -M main
git remote add origin https://github.com/<you>/Spotlight-backend.git
git push -u origin main
```

## Docs

Full setup, Supabase migrations, and Vercel deploy: [`docs/PHASE-0.md`](./docs/PHASE-0.md).
