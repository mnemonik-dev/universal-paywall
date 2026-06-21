# MusicBrainz — the registry / moat (resolver enrichment)

Not a payable vertical on its own. MusicBrainz is the **identity registry** that
turns a music scrobble into a payable creator. The Navidrome/ListenBrainz sidecar
(`../navidrome/`) hands us a `recording_mbid`; MusicBrainz maps it to the
**artist** (`artist_mbid`); the proprietary `artist_mbid -> wallet` table is the
moat. Closing this replaces the static `mapResolver` with a real
`resolveCreator` for every MusicBrainz-keyed music source.

## Attach surface (read-only, no fork change)

`musicbrainz-server` exposes the MusicBrainz WS/2 API:

- `GET /ws/2/recording/<recording_mbid>?inc=artists&fmt=json`
  -> `artist-credit[].artist.id` (the `artist_mbid`).
- Run the fork locally, or use the public `https://musicbrainz.org/ws/2/`
  (rate-limited to ~1 req/s; **must** send a descriptive `User-Agent`).

## What we build (gap #4 — implementation phase)

A `musicbrainzResolver` in `@universal-paywall/integrations` that composes with the
existing `Resolve` type (`core.ts`). Two stages, both cached:

```
recording_mbid --[WS/2 /recording?inc=artists]--> artist_mbid --[wallet registry]--> 0xCreator
```

```ts
export interface MusicBrainzResolverOptions {
  /** artist_mbid -> wallet (the moat). Static map now; a DB/registry later. */
  walletRegistry: Resolve;
  /** WS/2 base. Default https://musicbrainz.org/ws/2/ ; point at the local fork in tests. */
  baseUrl?: string;
  /** Required by MusicBrainz etiquette. */
  userAgent: string;
  /** TTL for the recording->artist cache (default 24h) and a 1 req/s limiter. */
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
}
// returns a Resolve usable as `resolveCreator`; unknown MBIDs -> null (meter-and-skip).
export function createMusicBrainzResolver(opts: MusicBrainzResolverOptions): Resolve;
```

Design rules:
- **Cache aggressively** (recording->artist is immutable) and **rate-limit** to
  respect WS/2; prefer the local fork in CI/e2e to avoid the public limiter.
- **Fallback:** if a scrobble already carries `artist_mbids` (it usually does — see
  `listenCreatorKey`), resolve straight from the registry and skip the WS/2 call.
- **Unknown -> null:** unmapped artists meter-and-skip, never throw (matches the
  package contract).
- The resolver is **async**, so wiring it as `resolveCreator` requires `Resolve` to
  allow a `Promise` return (small `core.ts` change tracked with this gap).

## Wiring

```
ListenBrainz sidecar (PLATFORM=navidrome)
   resolveCreator = createMusicBrainzResolver({ walletRegistry, userAgent })
   recording_mbid -> artist_mbid -> wallet -> charge
```

## Steps

1. Implement `createMusicBrainzResolver` (+ cache + limiter) and allow async
   `Resolve`.
2. Seed the `walletRegistry` (artist_mbid -> wallet) — static map first, a managed
   registry later.
3. Point the Navidrome sidecar's `resolveCreator` at it.

## Verify

Given a known `recording_mbid`, the resolver returns a stable `artist_mbid` and (if
registered) a wallet; an unknown MBID returns `null`. Test against the local
`musicbrainz-server` fork so CI doesn't hit the public rate limiter. See the
testing plan (MusicBrainz/Navidrome row).
</content>
