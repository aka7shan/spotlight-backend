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

  app.use('*', logger());
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      // Reflect the request origin when it is in the allow-list (required for credentials).
      origin: (origin) => {
        if (!origin) return env.CORS_ORIGINS[0] ?? '';
        return env.CORS_ORIGINS.includes(origin) ? origin : '';
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

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
