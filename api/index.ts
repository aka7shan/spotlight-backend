/**
 * Vercel serverless entry point.
 *
 * vercel.json rewrites all non-/health paths to `/api`, which lands here.
 * Hono handles the actual routing using the original request URL.
 */
import { handle } from 'hono/vercel';
import { buildApp } from '../src/app.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 10,
};

const app = buildApp();

export default handle(app);
