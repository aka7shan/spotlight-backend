/**
 * Vercel serverless entry — lazy-loads the Hono app so /health can stay lightweight.
 */
import type { Hono } from 'hono';

export const config = {
  runtime: 'nodejs',
  maxDuration: 10,
};

let app: Hono | null = null;

export default async function handler(req: Request): Promise<Response> {
  if (!app) {
    const { buildApp } = await import('../src/app.js');
    app = buildApp();
  }
  return app.fetch(req);
}
