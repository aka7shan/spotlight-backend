import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { env } from '../env.js';

/**
 * Central error handler for the Hono app.
 * Maps thrown errors to consistent JSON responses.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  // Hono's own HTTPException — already shaped
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: {
          code: err.status,
          message: err.message,
        },
      },
      err.status,
    );
  }

  // Zod validation errors
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 422,
          message: 'Validation failed',
          details: err.issues,
        },
      },
      422,
    );
  }

  // Everything else — log and return a generic 500
  console.error('[unhandled]', err);
  return c.json(
    {
      error: {
        code: 500,
        message: 'Internal server error',
        // Only leak details outside of production
        ...(env.NODE_ENV !== 'production'
          ? { detail: err instanceof Error ? err.message : String(err) }
          : {}),
      },
    },
    500,
  );
};
