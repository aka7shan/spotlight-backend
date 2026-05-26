/**
 * Lightweight health check — no DB, no auth, fast cold start on Vercel.
 */
export const config = {
  runtime: 'nodejs',
};

export default function handler(): Response {
  return Response.json({
    status: 'ok',
    env: process.env.NODE_ENV ?? 'unknown',
    timestamp: new Date().toISOString(),
  });
}
