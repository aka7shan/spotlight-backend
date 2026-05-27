import { Hono } from 'hono';
import { env } from '../env.js';
import { pingDb } from '../lib/db.js';

export const healthRoutes = new Hono();

/**
 * Liveness check — always cheap, no external dependencies. Used by Vercel's
 * own monitoring and by uptime probes. If this 200s the process is up.
 *
 * The Edge handler at /api/health takes precedence via vercel.json rewrites,
 * so this route is mostly the local-dev twin.
 */
healthRoutes.get('/health', (c) =>
  c.json({
    status: 'ok',
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  }),
);

/**
 * Readiness check — verifies the database is reachable. Use this for alerts;
 * use /health for liveness. We deliberately don't check Supabase JWKS here
 * because that endpoint is cached aggressively and a single transient miss
 * shouldn't page anyone.
 */
healthRoutes.get('/health/deep', async (c) => {
  const checks: Record<string, { ok: boolean; durationMs?: number; error?: string }> = {};

  try {
    const durationMs = await pingDb(2000);
    checks.database = { ok: true, durationMs };
  } catch (err) {
    checks.database = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return c.json(
    {
      status: allOk ? 'ok' : 'degraded',
      env: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      checks,
    },
    allOk ? 200 : 503,
  );
});
