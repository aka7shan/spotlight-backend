import type { MiddlewareHandler } from 'hono';

/**
 * Production access logger.
 *
 * Hono's `logger()` is great for local dev — every request gets a colored
 * one-liner — but in production it doubles the log volume and obscures what
 * actually matters (slow requests and errors). This middleware only logs:
 *
 *   - any request with status >= 400
 *   - any request slower than `slowMs` (default 1500ms)
 *
 * Output is single-line JSON so Vercel's log search ("status:500") and any
 * future log shipper can index it without a parser.
 */
export interface AccessLogOptions {
  /** Threshold for "slow request" warnings in milliseconds. */
  slowMs?: number;
}

export function accessLog(options: AccessLogOptions = {}): MiddlewareHandler {
  const slowMs = options.slowMs ?? 1500;

  return async function accessLogMiddleware(c, next) {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    const status = c.res.status;

    if (status >= 400 || durationMs >= slowMs) {
      // Reach into the underlying Request for headers; Hono's c.req.header()
      // is the public API and works on every runtime.
      const requestId =
        c.req.header('x-request-id') ?? c.req.header('x-vercel-id') ?? undefined;

      const line = {
        kind: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'slow',
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs,
        requestId,
      };
      // Use the appropriate console level so log filters work; in Vercel a
      // console.error becomes stderr and shows up as "Error" in the UI.
      if (status >= 500) console.error(JSON.stringify(line));
      else console.warn(JSON.stringify(line));
    }
  };
}
