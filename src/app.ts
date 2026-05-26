import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './env.js';
import { errorHandler } from './middleware/error.js';
import type { AuthVariables } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';

/**
 * Build the Hono app.
 * Exported as a factory so we can reuse the same wiring for:
 *   - local Node server (src/index.ts)
 *   - Vercel serverless handler (api/index.ts)
 *   - Future: Cloudflare Workers, Bun, etc.
 *
 * The app is intentionally framework-only here — no runtime adapter (no
 * `serve()` call, no `handle()` call). The caller wires it up.
 */
export function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();

  // -------------------------------------------------------------------------
  // Global middleware
  // -------------------------------------------------------------------------

  // CORS first so OPTIONS preflights short-circuit before any heavier work.
  app.use(
    '*',
    cors({
      origin: (origin: string | undefined) => {
        if (origin && env.CORS_ORIGINS.includes(origin)) return origin;
        if (!origin) return env.CORS_ORIGINS[0];
        return null;
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  app.use('*', secureHeaders());
  if (env.NODE_ENV !== 'production') {
    app.use('*', logger());
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  app.get('/', (c) =>
    c.json({
      name: 'spotlight-backend',
      version: '0.1.0',
      docs: 'https://github.com/your-org/spotlight-portfolio',
    }),
  );

  app.route('/', healthRoutes);
  app.route('/v1/me', meRoutes);

  // -------------------------------------------------------------------------
  // 404 + error handler (must come last)
  // -------------------------------------------------------------------------

  app.notFound((c) =>
    c.json({ error: { code: 404, message: `Not Found: ${c.req.method} ${c.req.path}` } }, 404),
  );
  app.onError(errorHandler);

  return app;
}
