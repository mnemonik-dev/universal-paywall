import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Reporter } from './core.js';
import { handleSharedLinkResolve } from './immich.js';

/**
 * Photo — Immich shared-link **reverse-proxy** wrapper (zero-config auto-attach).
 *
 * Put this in front of Immich; it transparently proxies every request and, on each
 * external **shared-link asset resolve** (`GET /api/assets/:id/{original,thumbnail,
 * video/playback}?key=…|slug=…`), looks up the asset's owner (and EXIF artist when
 * present) and reports a per-resolve license fee via the existing
 * `handleSharedLinkResolve`. No edit to Immich — it attaches at the HTTP boundary.
 *
 * Routes verified against Immich's OpenAPI: `GET /api/assets/{id}` returns
 * `ownerId` + `exifInfo` and accepts a `key`/`slug`; the file-serving routes accept
 * the same share params.
 */

const ASSET_FILE_RE = /^\/api\/assets\/([0-9a-fA-F-]{8,})\/(original|thumbnail|video\/playback)$/;

export interface ImmichProxyOptions {
  /** Upstream Immich base URL, e.g. http://127.0.0.1:2283 */
  upstreamUrl: string;
  reporter: Reporter;
  /** Per-resolve license fee in micro-USDC. */
  licenseFee: bigint;
  /** Dedupe window so thumbnail+original of one view bill once (ms; default 60s). */
  dedupeMs?: number;
  fetchImpl?: typeof fetch;
}

/** Parses a shared-asset-resolve request into `{ assetId, share }`, or null. */
export function parseAssetResolve(method: string | undefined, url: URL): { assetId: string; share: string } | null {
  if (method !== 'GET') return null;
  const m = ASSET_FILE_RE.exec(url.pathname);
  const assetId = m?.[1];
  if (assetId === undefined) return null;
  const share = url.searchParams.get('key') ?? url.searchParams.get('slug');
  if (share === null || share === '') return null; // only external share access carries key/slug
  return { assetId, share };
}

/** Builds a Node request handler that proxies to Immich and meters shared resolves. */
export function createImmichProxy(opts: ImmichProxyOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const upstream = opts.upstreamUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const dedupeMs = opts.dedupeMs ?? 60_000;
  const seen = new Map<string, number>();

  async function meterResolve(assetId: string, share: string, resolverId: string): Promise<void> {
    const key = `${share}:${assetId}`;
    const now = Date.now();
    const prev = seen.get(key);
    if (prev !== undefined && now - prev < dedupeMs) return; // already billed this view
    seen.set(key, now);
    try {
      const url = `${upstream}/api/assets/${assetId}?key=${encodeURIComponent(share)}`;
      const meta = (await (await doFetch(url, { headers: { accept: 'application/json' } })).json()) as {
        ownerId?: string;
        exifInfo?: { artist?: string } | null;
      };
      if (meta.ownerId === undefined) return;
      await handleSharedLinkResolve(
        {
          resolverId,
          assetId,
          ...(meta.exifInfo?.artist ? { exifArtist: meta.exifInfo.artist } : {}),
          ownerId: meta.ownerId,
        },
        opts.reporter,
        { licenseFee: opts.licenseFee },
      );
    } catch {
      seen.delete(key); // let a later request retry on a transient failure
    }
  }

  return (req, res) => {
    void proxy(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway' }));
    });
  };

  async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const resolve = parseAssetResolve(req.method, url);

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req) as ReadableStream;
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

    // Meter a successful external resolve (after we've decided to serve it).
    if (resolve !== null && upstreamRes.status >= 200 && upstreamRes.status < 300) {
      const resolverId = (req.headers['x-resolver-id'] as string | undefined) ?? resolve.share;
      void meterResolve(resolve.assetId, resolve.share, resolverId);
    }

    if (upstreamRes.body) {
      await new Promise<void>((resolve2, reject) => {
        Readable.fromWeb(upstreamRes.body as never)
          .on('error', reject)
          .pipe(res)
          .on('finish', resolve2)
          .on('error', reject);
      });
    } else {
      res.end();
    }
  }
}
