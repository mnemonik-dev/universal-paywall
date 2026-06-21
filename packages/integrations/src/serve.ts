import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Reporter } from './core.js';
import { handleScrobble, parseSubsonicScrobble, type ScrobbleOptions } from './subsonic.js';
import { OwncastPresenceMeter, type OwncastMeterOptions, type OwncastWebhookEvent } from './owncast.js';
import { handleJellyfinEvent, type JellyfinMeterOptions, type JellyfinWebhookEvent } from './jellyfin.js';
import { handleCitation, type CitationEvent, type CitationOptions } from './rsshub.js';
import { handleSharedLinkResolve, type SharedLinkOptions, type SharedLinkResolveEvent } from './immich.js';
import {
  handleListenSubmit,
  parseListenToken,
  type ListenBrainzOptions,
  type ListenSubmission,
} from './listenbrainz.js';
import { buildDonationCampaign, type DonationCampaignOptions } from './mastodon.js';

const MAX_BODY = 64 * 1024;

export type RouteHandler = (ctx: { body: unknown; url: URL; headers: IncomingHttpHeaders }) => Promise<unknown>;

/**
 * Lets a route return a non-200 status (e.g. Mastodon's 204 "no banner"). A plain
 * object returned from a handler is still serialized as a 200 JSON body.
 */
export class RouteResponse {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}

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

/**
 * JSON serializer that stringifies bigints. Route outcomes carry `amount: bigint`
 * (micro-USDC), which `JSON.stringify` cannot serialize natively — without this an
 * HTTP-served charge would 500/400. Emits amounts as decimal strings.
 */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
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
  const result = await route.handle({ body, url, headers: req.headers });
  if (result instanceof RouteResponse) {
    if (result.body === undefined) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(toJson(result.body));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(toJson(result ?? { ok: true }));
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

/**
 * ListenBrainz-compatible endpoints (Navidrome's native scrobble target). Returns
 * the two routes its client calls under `${prefix}` (default `/1`, matching
 * `ND_LISTENBRAINZ_BASEURL=…/1/`): `validate-token` (so the token links) and
 * `submit-listens` (the per-listen charge). Both speak the ListenBrainz wire shape.
 */
export function listenBrainzRoutes(reporter: Reporter, opts: ListenBrainzOptions, prefix = '/1'): readonly Route[] {
  return [
    {
      method: 'GET',
      path: `${prefix}/validate-token`,
      handle: async ({ headers }) => {
        const token = parseListenToken(headers.authorization);
        // Permissionless: any token links; unknown ones meter-and-skip at scrobble.
        return { code: 200, message: 'Token valid.', valid: true, user_name: token ?? 'universal-paywall' };
      },
    },
    {
      method: 'POST',
      path: `${prefix}/submit-listens`,
      handle: async ({ body, headers }) => {
        await handleListenSubmit(body as ListenSubmission, parseListenToken(headers.authorization), reporter, opts);
        return { status: 'ok' };
      },
    },
  ];
}

/**
 * Mastodon donation-campaign provider. Serves the campaign JSON Mastodon fetches
 * + caches from `DONATION_CAMPAIGNS_URL` (default path `/api/v1/donation_campaigns`),
 * echoing the requested `locale`. Returns 204 when no campaign is configured.
 */
export function mastodonCampaignRoute(opts: DonationCampaignOptions, path = '/api/v1/donation_campaigns'): Route {
  return {
    method: 'GET',
    path,
    handle: async ({ url }) => {
      const campaign = buildDonationCampaign(opts, {
        platform: url.searchParams.get('platform'),
        seed: url.searchParams.get('seed'),
        locale: url.searchParams.get('locale'),
        environment: url.searchParams.get('environment'),
      });
      return campaign === null ? new RouteResponse(204) : campaign;
    },
  };
}
