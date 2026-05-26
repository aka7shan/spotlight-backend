/**
 * Edge health check — minimal cold start, no Node postgres bundle.
 */
export const config = {
  runtime: 'edge',
};

export default function handler(): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      env: process.env.NODE_ENV ?? 'unknown',
      timestamp: new Date().toISOString(),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
