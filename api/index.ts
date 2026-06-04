/**
 * Vercel serverless entry — Node runtime.
 *
 * Thin re-export of `src/app.ts`'s default handler. The actual Node↔Web
 * adapter (IncomingMessage → Request → Hono → Response → ServerResponse)
 * lives in `src/app.ts` so that whichever file `@vercel/node` resolves the
 * function entry to — `api/index.js` or `src/app.js` — both serve the same
 * working handler. See the long comment in `src/app.ts` for why we do this.
 *
 * `config` is declared locally (not re-exported) because Vercel's static
 * analyzer reads it directly from the file it considers the function entry.
 * Re-exported `config` is silently ignored on some builder versions.
 */
export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
};

export { default } from '../src/app.js';
