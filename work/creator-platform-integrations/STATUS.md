---
feature: creator-platform-integrations
doc: status
created: 2026-06-17
---

# Status

## Implemented (runnable, tested)

`@universal-paywall/integrations` — permissionless sidecars + a runnable serve
layer + CLI.

| Vertical | Adapter | Runnable route | Tested |
|---|---|---|---|
| Music (Subsonic) | `handleScrobble`, `parseSubsonicScrobble` | `subsonicRoute` (GET `/rest/scrobble.view`) | ✓ |
| Music (Navidrome/ListenBrainz) | `handleListenSubmit`, `parseListenToken`, `listenCreatorKey` | `listenBrainzRoutes` (GET `/1/validate-token`, POST `/1/submit-listens`) | ✓ |
| Live video (Owncast) | `OwncastPresenceMeter` | `owncastRoute` (POST `/owncast`) | ✓ |
| VOD (Jellyfin) | `handleJellyfinEvent` | `jellyfinRoute` (POST `/jellyfin`) | ✓ |
| Feeds (RSSHub) | `handleCitation` | `citationRoute` (POST `/citation`) | ✓ |
| Photo (Immich) | `handleSharedLinkResolve` + `createImmichProxy` (reverse-proxy) | `immichRoute` / `PLATFORM=immich-proxy` | ✓ (real L3) |
| Fediverse (Mastodon) | `buildDonationCampaign` | `mastodonCampaignRoute` (GET `/api/v1/donation_campaigns`) | ✓ |

- `createSidecarServer(routes)` + `up-integration` CLI: run any sidecar from env
  (`PLATFORM`, `FACILITATOR_URL`, `FACILITATOR_API_KEY`, `PAYER_WALLETS`,
  `CREATOR_WALLETS`, `RATE`, `STREAMER_KEY`, `PORT`, `SIDECAR_API_KEY`).
- **48 unit tests** (core resolver, all verticals + the immich/subsonic reverse-proxies, route builders).

## Proven end-to-end

`npm run e2e:anvil -w @universal-paywall/integrations` — full vertical loop on
anvil: viewer stakes+grants (agent) → **Owncast presence event → sidecar reporter
→ SDK → facilitator → batched on-chain settle → streamer paid 60000** (60s × 1000
micro-USDC). **PASS**.

## Plugin / provider drafts (no auto-PR)

`pr-drafts.md` — PeerTube published-plugin (`main.js` view-hook) and Mastodon
campaign-source provider, with the exact upstream path. Not submitted (out of
GitHub scope; permissionless-by-design; upstreams reject per-user payment
plumbing).

## Whole-repo test totals (this branch)

contracts **39** · facilitator **20** · sdk **4** · resource-adapter **10** ·
agent **11** · integrations **48** (+ peertube-plugin **9** · extension **13** node
assertions) → **132 vitest + 22 node**, all PASS. Plus **real Docker L3s** for
Owncast / Navidrome+MusicBrainz / Jellyfin / RSSHub / Immich / Subsonic / PeerTube
(browser player) / Mastodon (full stack), the **extension browser E2E** (headless
Chromium), and the Mastodon donation L4 — every on-chain settle verified.

## Deployment recipes + gap status (forks now in scope)

`packages/integrations/deploy/<platform>/` — grounded sidecar-attach recipes.
All five gaps **closed**: **#1 Navidrome** (ListenBrainz target), **#2 Mastodon**
(campaign provider + donation L4), **#3 PeerTube plugin** (`packages/peertube-plugin/`),
**#4 MusicBrainz resolver** (recording→artist→wallet via WS/2; async `Resolve`;
live-validated), **#5 browser-extension adaptor** (`packages/extension/` MV3 +
agent account/transport injection). Only external store/registry **publishing**
remains. See `deployment-plan.md` and the per-recipe READMEs.

## Testing

`testing-plan.md` — four-layer verification per platform (L1 unit → L2 sidecar HTTP
contract → L3 real Docker'd instance → L4 anvil on-chain money loop) + the
per-platform test matrix.

## Remaining / future

- [x] Owncast L4 acceptance over real HTTP (`e2e:owncast`) — PASS; found+fixed the
      bigint-over-HTTP serialization bug affecting all charge routes.
- [x] Owncast **real L3** (live `owncast/owncast` container, RTMP stream, real chat
      join/part -> real webhook -> on-chain settle, streamer paid 14000) — PASS.
      Docker works here once `dockerd` is started.
- [x] Navidrome **real L3** (live `ghcr.io/navidrome/navidrome`, native ListenBrainz
      scrobble -> recording_mbid -> live MusicBrainz artist -> on-chain settle, artist
      paid 100) — PASS. Field-verifies gaps #1 + #4 together.
- [x] Jellyfin **real L3** (live `ghcr.io/jellyfin/jellyfin` + official Webhook
      plugin, real PlaybackStop -> per-minute bill -> on-chain settle, creator paid
      2000) — PASS.
- [x] PeerTube **real L3+L4** (live PeerTube 7.3.0 + a real headless-browser player ->
      counted view -> action:api.video.viewed -> on-chain settle). Live run also
      found+fixed a real bug (MVideoImmutable has no channelId).
- [x] Browser-extension **E2E** (`e2e:anvil`): real payer loop through the handler+bridge,
      agent from an injected account, auto-pays a real x402 resource -> 402->grant->200 ->
      on-chain settle -> creator paid 50000. Headless equivalent of the extension auto-paying.
- [x] All platform L3s done incl. **Mastodon full-stack L3** (live Mastodon fetched our provider) and **Subsonic** (gonic).
- [x] Gap #4: `createMusicBrainzResolver` (async `Resolve`) — built + live-validated; wired into Navidrome/Subsonic via `MUSICBRAINZ_USER_AGENT`.
- [x] Real Navidrome L3 (docker) using the resolver: scrobble -> recording_mbid -> artist -> settle. PASS.
- [x] Gap #5: `@universal-paywall/extension` (MV3) + agent signer/transport injection — node E2E + **headless-Chromium browser E2E** PASS.
- [x] Gap #3: `peertube-plugin-universal-paywall` built + self-contained bundle; **real PeerTube 7.3.0 L3+L4 PASS** (headless browser player). Only npm/index publish is external.
- [x] Immich shared-link **reverse-proxy variant** (`createImmichProxy`, `PLATFORM=immich-proxy`):
      built + 5 unit tests + **real L3** against live Immich (server + vectorchord pg + redis):
      external viewer resolves a shared-link asset through the proxy -> license fee -> on-chain
      settle -> owner paid 25000. No Immich fork needed (ran the upstream image).
- [ ] Federation-peer sidecar for Mastodon per-user (`attributedTo`) reshare settlement.
