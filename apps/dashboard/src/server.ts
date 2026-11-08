import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceBuffer } from './traces.js';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const digest = (text: string) => createHash('sha256').update(text).digest();

export function createDashboardServer(
  buffer: TraceBuffer,
  options: { password?: string | undefined; assetsDir?: string } = {},
) {
  const assetsDir =
    options.assetsDir ??
    dirname(fileURLToPath(import.meta.resolve('@onxbot/dashboard/client')));
  const expected = options.password
    ? digest(
        `Basic ${Buffer.from(`onxbot:${options.password}`).toString('base64')}`,
      )
    : undefined;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response
      .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(value));
  };
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (
      expected &&
      !timingSafeEqual(digest(request.headers.authorization ?? ''), expected)
    ) {
      response
        .writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Onxbot dashboard"',
        })
        .end();
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      json(response, 405, { error: 'Method not allowed' });
      return;
    }
    const url = URL.parse(request.url ?? '/', 'http://localhost');
    if (!url) {
      json(response, 400, { error: 'Invalid URL' });
      return;
    }
    if (url.pathname === '/api/traces') {
      const session = url.searchParams.get('session');
      const traces = buffer
        .list()
        .filter((trace) => !session || trace.session === session)
        .map(({ events, ...trace }) => ({
          ...trace,
          eventCount: events.length,
        }));
      json(response, 200, { startedAt: buffer.startedAt, limit: 50, traces });
      return;
    }
    const match = /^\/api\/traces\/(\d+)$/.exec(url.pathname);
    if (match) {
      const trace = buffer.get(Number(match[1]));
      json(
        response,
        trace ? 200 : 404,
        trace ?? { error: 'Trace no longer available' },
      );
      return;
    }
    const serve = async () => {
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        json(response, 400, { error: 'Invalid path' });
        return;
      }
      if (
        path !== '/' &&
        path !== '/favicon.svg' &&
        !path.startsWith('/assets/')
      ) {
        json(response, 404, { error: 'Not found' });
        return;
      }
      const root = await realpath(assetsDir);
      const file = await realpath(
        resolve(root, path === '/' ? 'index.html' : `.${path}`),
      ).catch(() => undefined);
      if (!file?.startsWith(`${root}${sep}`) || !mime[extname(file)]) {
        json(response, 404, { error: 'Not found' });
        return;
      }
      const content = await readFile(file);
      if (path.startsWith('/assets/'))
        response.setHeader(
          'Cache-Control',
          'public, max-age=31536000, immutable',
        );
      response
        .writeHead(200, {
          'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        })
        .end(content);
    };
    void serve().catch(() =>
      json(response, 500, {
        error: 'Dashboard assets unavailable. Run pnpm build.',
      }),
    );
  });
}
