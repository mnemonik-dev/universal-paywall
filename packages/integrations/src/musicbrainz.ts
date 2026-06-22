import type { Hex, Resolve } from './core.js';

/**
 * MusicBrainz resolver — the registry/moat behind music payouts.
 *
 * A scrobble gives us a `recording_mbid` (or `artist_mbid`); MusicBrainz WS/2 maps
 * a recording to its artist(s); the proprietary `artist_mbid -> wallet` table (the
 * `walletRegistry`) is the moat. Use the returned `Resolve` as `resolveCreator` on
 * the Navidrome/ListenBrainz sidecar.
 *
 *   recording_mbid --[WS/2 /recording?inc=artists]--> artist_mbid --[registry]--> 0xCreator
 *
 * Etiquette/robustness (per MusicBrainz WS/2 rules):
 *  - sends a descriptive `User-Agent` (required),
 *  - serializes + rate-limits requests (default 1 req/s),
 *  - caches recording->artists (immutable; default 24h),
 *  - never throws: unknown/unparseable/error -> null (the sidecar meters-and-skips).
 */

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MusicBrainzResolverOptions {
  /** `artist_mbid` (or any pre-registered key) -> wallet. Static map now; a managed registry later. */
  walletRegistry: Resolve;
  /** Required by MusicBrainz etiquette, e.g. `universal-paywall/0.1 (ops@example.com)`. */
  userAgent: string;
  /** WS/2 base. Default `https://musicbrainz.org/ws/2`; point at the local fork in tests/CI. */
  baseUrl?: string;
  /** recording->artists cache TTL (default 24h). */
  cacheTtlMs?: number;
  /** Min spacing between WS/2 requests (default 1000ms). */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface RecordingResponse {
  'artist-credit'?: Array<{ artist?: { id?: string } }>;
}

/** Builds a (cached, rate-limited) `Resolve` keyed on recording or artist MBID. */
export function createMusicBrainzResolver(opts: MusicBrainzResolverOptions): Resolve {
  const baseUrl = (opts.baseUrl ?? 'https://musicbrainz.org/ws/2').replace(/\/$/, '');
  const ttl = opts.cacheTtlMs ?? 24 * 60 * 60 * 1000;
  const minInterval = opts.minIntervalMs ?? 1000;
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, { artists: string[]; expires: number }>();

  // Serialize WS/2 calls and space them by >= minInterval (MusicBrainz allows ~1/s).
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = minInterval - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function artistsFor(recordingMbid: string): Promise<string[]> {
    const hit = cache.get(recordingMbid);
    if (hit !== undefined && hit.expires > Date.now()) return hit.artists;
    const artists = await schedule(async () => {
      try {
        const res = await doFetch(`${baseUrl}/recording/${recordingMbid}?inc=artists&fmt=json`, {
          headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
        });
        if (!res.ok) return [];
        const data = (await res.json()) as RecordingResponse;
        return (data['artist-credit'] ?? [])
          .map((c) => c.artist?.id)
          .filter((id): id is string => typeof id === 'string' && id !== '');
      } catch {
        return [];
      }
    });
    cache.set(recordingMbid, { artists, expires: Date.now() + ttl });
    return artists;
  }

  return async (key: string): Promise<Hex | null | undefined> => {
    // Fast path: the key is already registered (a known artist_mbid, or a
    // recording_mbid mapped directly) — no network call.
    const direct = await opts.walletRegistry(key);
    if (direct !== null && direct !== undefined) return direct;

    // Otherwise treat it as a recording MBID and resolve its artist(s).
    if (!MBID_RE.test(key)) return null;
    for (const artistMbid of await artistsFor(key)) {
      const wallet = await opts.walletRegistry(artistMbid);
      if (wallet !== null && wallet !== undefined) return wallet;
    }
    return null;
  };
}
