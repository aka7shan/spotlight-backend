/**
 * Vercel serverless function entry point.
 *
 * vercel.json rewrites every incoming path to `/api`, which lands here.
 * Hono handles the actual routing.
 */
import { handle } from 'hono/vercel';
import { buildApp } from '../src/app.js';

export const config = {
  runtime: 'nodejs',
};

const app = buildApp();

export default handle(app);
