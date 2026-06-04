import type { IncomingMessage, ServerResponse } from 'node:http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './env.js';
import { errorHandler } from './middleware/error.js';
import { accessLog } from './middleware/access-log.js';
import type { AuthVariables } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { shortRoutes } from './routes/short.js';

/**
 * Hard ceiling on request body size at the Hono layer.
 *
 * Vercel rejects bodies > 4.5 MB at the platform layer with an opaque
 * error; rejecting earlier with a clean 413 + JSON envelope is friendlier.
 *
 * Sized at 6 MB right now because the Phase 0 frontend can still produce
 * an avatar payload up to ~6.7 MB (a 5 MB image base64-encoded). Once
 * avatar uploads move to Supabase Storage the avatar/cover image fields
 * become URLs and this can drop to ~256 KB.
 */
const MAX_BODY_BYTES = 6 * 1024 * 1024;

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
      // X-Request-Id is a forward-looking addition: lets the frontend supply
      // its own correlation id so logs on both sides line up. Free to add now.
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use('*', secureHeaders());

  // Dev: colored one-line-per-request log for fast feedback.
  // Prod: structured JSON, only for errors and slow requests (see accessLog).
  if (env.NODE_ENV !== 'production') {
    app.use('*', logger());
  } else {
    app.use('*', accessLog({ slowMs: 1500 }));
  }

  // Body-size guard. Applied globally — bodyLimit short-circuits via the
  // Content-Length header for requests that don't have a body, so the cost
  // on GETs is one header read.
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: 413,
              message: `Request body exceeds the ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB limit.`,
            },
          },
          413,
        ),
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
  // Phase 1.2: anonymous public lookup by Base62 short code.
  //   /v1/p/:code  →  the public portfolio for that code
  // Mints + management of the code lives on /v1/me (see meRoutes).
  app.route('/v1/p', shortRoutes);

  // -------------------------------------------------------------------------
  // 404 + error handler (must come last)
  // -------------------------------------------------------------------------

  app.notFound((c) =>
    c.json({ error: { code: 404, message: `Not Found: ${c.req.method} ${c.req.path}` } }, 404),
  );
  app.onError(errorHandler);

  return app;
}

// =============================================================================
// Vercel Node-runtime serverless handler
// =============================================================================
//
// Why is this here (and not only in api/index.ts)?
// ------------------------------------------------
// `@vercel/node` resolves the function entry for `/api` to whichever compiled
// `.js` it can find under /var/task that matches its rewrite target — and on
// some recent build runs that ends up being `/var/task/src/app.js`, not
// `/var/task/api/index.js`. When the chosen entry's default export isn't a
// function, the runtime aborts with:
//
//   "Invalid export found in module \"/var/task/src/app.js\".
//    The default export must be a function or server."
//
// We can't reliably force @vercel/node to pick api/index.js — `functions` and
// `rewrites` together aren't enough on its own. So we make `src/app.ts` itself
// a valid serverless function entry and have `api/index.ts` re-export from it.
// Either resolution path now lands on the same working handler.
//
// The handler is the same Node↔Web adapter `hono/vercel` would give us on
// the Edge runtime, written manually for the Node runtime (where Vercel hands
// us IncomingMessage / ServerResponse instead of a Web Request).
// =============================================================================

const _coldStart = Date.now();
let _vercelApp: ReturnType<typeof buildApp> | undefined;

function _getVercelApp() {
  if (!_vercelApp) {
    _vercelApp = buildApp();
    console.log(`[boot] hono ready in ${Date.now() - _coldStart}ms`);
  }
  return _vercelApp;
}

function _readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
};

export default async function vercelNodeHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
    const host = req.headers.host ?? 'localhost';
    const url = `${proto}://${host}${req.url ?? '/'}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(key, value.join(', '));
      else if (value !== undefined) headers.set(key, String(value));
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const body = hasBody ? await _readBody(req) : undefined;

    const webReq = new Request(url, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined,
    });

    const webRes = await _getVercelApp().fetch(webReq);

    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('[handler] error', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 500, message: 'Internal Server Error' } }));
    } else {
      res.end();
    }
  }
}
