import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Reporter } from './core.js';
import { handleScrobble, parseSubsonicScrobble, type ScrobbleOptions } from './subsonic.js';
import { OwncastPresenceMeter, type OwncastMeterOptions, type OwncastWebhookEvent } from './owncast.js';
import { handleJellyfinEvent, type JellyfinMeterOptions, type JellyfinWebhookEvent } from './jellyfin.js';
import { handleCitation, type CitationEvent, type CitationOptions } from './rsshub.js';
import { handleSharedLinkResolve, type SharedLinkOptions, type SharedLinkResolveEvent } from './immich.js';

const MAX_BODY = 64 * 1024;

export type RouteHandler = (ctx: { body: unknown; url: URL }) => Promise<unknown>;

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handle: RouteHandler;
}

export interface SidecarServerOptions {
  /** If set, requests must present a matching `x-api-key`. */
  apiKey?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Builds a small HTTP server that dispatches platform events to the routes. */
export function createSidecarServer(routes: readonly Route[], opts: SidecarServerOptions = {}): Server {
  return createServer((req, res) => {
    void dispatch(req, res, routes, opts).catch((err: unknown) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad_request' }));
    });
  });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: readonly Route[],
  opts: SidecarServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  if (opts.apiKey !== undefined) {
    const key = req.headers['x-api-key'];
    if ((Array.isArray(key) ? key[0] : key) !== opts.apiKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }
  const body = req.method === 'POST' ? (JSON.parse((await readBody(req)) || 'null') as unknown) : null;
  const result = await route.handle({ body, url });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result ?? { ok: true }));
}

// ----- per-platform route builders -----

export function subsonicRoute(reporter: Reporter, opts: ScrobbleOptions, path = '/rest/scrobble.view'): Route {
  return {
    method: 'GET',
    path,
    handle: async ({ url }) => {
      const ev = parseSubsonicScrobble(url.searchParams);
      if (ev === null) return { status: 'ignored' };
      return handleScrobble(ev, reporter, opts);
    },
  };
}

export function owncastRoute(meter: OwncastPresenceMeter, path = '/owncast'): Route {
  return {
    method: 'POST',
    path,
    handle: async ({ body }) => (await meter.handle(body as OwncastWebhookEvent)) ?? { status: 'tracked' },
  };
}

export function jellyfinRoute(reporter: Reporter, opts: JellyfinMeterOptions, path = '/jellyfin'): Route {
  return {
    method: 'POST',
    path,
    handle: async ({ body }) => (await handleJellyfinEvent(body as JellyfinWebhookEvent, reporter, opts)) ?? { status: 'ignored' },
  };
}

export function citationRoute(reporter: Reporter, opts: CitationOptions, path = '/citation'): Route {
  return {
    method: 'POST',
    path,
    handle: async ({ body }) => handleCitation(body as CitationEvent, reporter, opts),
  };
}

export function immichRoute(reporter: Reporter, opts: SharedLinkOptions, path = '/immich/resolve'): Route {
  return {
    method: 'POST',
    path,
    handle: async ({ body }) => handleSharedLinkResolve(body as SharedLinkResolveEvent, reporter, opts),
  };
}
