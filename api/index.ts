/**
 * Vercel serverless entry — lazy-loads the Hono app so /health can stay lightweight.
 */
import type { Hono } from 'hono';
import type { AuthVariables } from '../src/middleware/auth.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 10,
};

type SpotlightApp = Hono<{ Variables: AuthVariables }>;

let app: SpotlightApp | null = null;

export default async function handler(req: Request): Promise<Response> {
  if (!app) {
    const { buildApp } = await import('../src/app.js');
    app = buildApp();
  }

  const hono = app;
  return hono.fetch(req);
}
