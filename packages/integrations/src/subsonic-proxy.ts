import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Reporter } from './core.js';
import { handleScrobble, parseSubsonicScrobble } from './subsonic.js';

/**
 * Music — Subsonic **reverse-proxy** wrapper (Subsonic family: gonic, airsonic,
 * ampache, …). Put this in front of a Subsonic server; it transparently proxies
 * every request and, on each scrobble submission (`GET /rest/scrobble.view?...&id=…`
 * with `submission` != false), reports a per-listen royalty via `handleScrobble`.
 * No edit to the server — it attaches at the HTTP boundary; clients point at the
 * proxy instead of the server directly. (For Navidrome specifically, the
 * `listenBrainzRoutes` config-redirect is cleaner; this covers the rest of the
 * Subsonic family / the proxy mechanism.)
 */

export interface SubsonicProxyOptions {
  /** Upstream Subsonic base URL, e.g. http://127.0.0.1:4747 */
  upstreamUrl: string;
  reporter: Reporter;
  /** Per-play amount in micro-USDC. */
  ratePerPlay: bigint;
  fetchImpl?: typeof fetch;
}

/** True for a scrobble *submission* (a real play), not a now-playing update. */
export function isScrobbleSubmission(url: URL): boolean {
  if (!/\/rest\/scrobble(\.view)?$/.test(url.pathname)) return false;
  if (url.searchParams.get('id') === null) return false;
  const sub = url.searchParams.get('submission');
  return sub === null || sub.toLowerCase() !== 'false'; // default submission=true
}

/** Builds a Node request handler that proxies to a Subsonic server and meters scrobbles. */
export function createSubsonicProxy(opts: SubsonicProxyOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const upstream = opts.upstreamUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  return (req, res) => {
    void proxy(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway' }));
    });
  };

  async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const meter = isScrobbleSubmission(url) ? parseSubsonicScrobble(url.searchParams) : null;

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k === 'host' || k === 'connection') continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const upstreamRes = await doFetch(`${upstream}${req.url}`, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body, duplex: 'half' } : {}),
      redirect: 'manual',
    } as RequestInit);

    const outHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (k !== 'content-encoding' && k !== 'transfer-encoding') outHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, outHeaders);

    // Meter only when the server accepted the scrobble.
    if (meter !== null && upstreamRes.status >= 200 && upstreamRes.status < 300) {
      void handleScrobble(meter, opts.reporter, { ratePerPlay: opts.ratePerPlay });
    }

    if (upstreamRes.body) {
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(upstreamRes.body as never)
          .on('error', reject)
          .pipe(res)
          .on('finish', resolve)
          .on('error', reject);
      });
    } else {
      res.end();
    }
  }
}
