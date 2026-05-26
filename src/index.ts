/**
 * Local dev entry point — runs the Hono app on Node.
 * Vercel uses api/index.ts instead.
 */
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { env } from './env.js';

const app = buildApp();

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`spotlight-backend listening on http://localhost:${info.port}`);
    console.log(`  env:           ${env.NODE_ENV}`);
    console.log(`  cors origins:  ${env.CORS_ORIGINS.join(', ')}`);
    console.log(`  health check:  http://localhost:${info.port}/health`);
  },
);
