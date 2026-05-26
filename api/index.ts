/**
 * Vercel serverless entry — Node runtime.
 *
 * `hono/vercel`'s `handle` only works on the Edge runtime; on the Node runtime
 * Vercel passes IncomingMessage/ServerResponse instead of a Web Request.
 * We adapt manually: Node req -> Web Request -> Hono app.fetch -> Web Response
 * -> Node res.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
};

const coldStart = Date.now();
const app = buildApp();
console.log(`[boot] hono ready in ${Date.now() - coldStart}ms`);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const body = hasBody ? await readBody(req) : undefined;

    const webReq = new Request(url, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined,
    });

    const webRes = await app.fetch(webReq);

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
