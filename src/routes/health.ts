import { Hono } from 'hono';
import { env } from '../env.js';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (c) =>
  c.json({
    status: 'ok',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  }),
);
