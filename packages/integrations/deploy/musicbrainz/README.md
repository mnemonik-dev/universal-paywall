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

## Status: BUILT + live-validated (gap #4 closed)

`createMusicBrainzResolver` (`src/musicbrainz.ts`) is implemented, unit-tested
(8 tests), and **validated against the real public WS/2** (2026-06-21): the
recording `f1aa509e-7cda-4e0e-b59b-f6ccfb53783c` resolved to its artist
(`4d5447d7-...` John Lennon) -> wallet; a repeated lookup was served from cache (1
network call); unknown -> null. `Resolve` is now async (`core.ts`), and the
Navidrome/Subsonic CLI modes use it when `MUSICBRAINZ_USER_AGENT` is set.

## How it works

A `Resolve` that composes with the existing type (`core.ts`). Two stages, both cached:

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

## Use it (Navidrome / Subsonic CLI)

Set `MUSICBRAINZ_USER_AGENT` (required by WS/2 etiquette) and key `CREATOR_WALLETS`
on `artist_mbid`:

```bash
PLATFORM=navidrome RATE=100 \
MUSICBRAINZ_USER_AGENT="universal-paywall/0.1 (ops@example.com)" \
CREATOR_WALLETS='{"4d5447d7-c61c-4120-ba1b-d7f471d385b9":"0xArtistWallet"}' \
FACILITATOR_URL=... FACILITATOR_API_KEY=... up-integration
```

`MUSICBRAINZ_BASE_URL` overrides WS/2 (point at the local `musicbrainz-server` fork
in CI to avoid the public ~1 req/s limiter). Without `MUSICBRAINZ_USER_AGENT` the
sidecar falls back to a direct `CREATOR_WALLETS` lookup (no MBID resolution).

## Verify

- **Unit:** `npm test -w @universal-paywall/integrations` (musicbrainz.test.ts).
- **Live:** point the resolver at `https://musicbrainz.org/ws/2` with a known
  `recording_mbid`; it returns the credited artist's wallet, caches the
  recording->artist mapping, and returns `null` for unknowns. Prefer the local fork
  for repeated/CI runs. See the testing plan (MusicBrainz/Navidrome row).
</content>
