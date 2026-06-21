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
| Photo (Immich) | `handleSharedLinkResolve` | `immichRoute` (POST `/immich/resolve`) | ✓ |
| Fediverse (Mastodon) | `buildDonationCampaign` | `mastodonCampaignRoute` (GET `/api/v1/donation_campaigns`) | ✓ |

- `createSidecarServer(routes)` + `up-integration` CLI: run any sidecar from env
  (`PLATFORM`, `FACILITATOR_URL`, `FACILITATOR_API_KEY`, `PAYER_WALLETS`,
  `CREATOR_WALLETS`, `RATE`, `STREAMER_KEY`, `PORT`, `SIDECAR_API_KEY`).
- **29 unit tests** (core resolver, verticals + ListenBrainz/Navidrome + Mastodon provider, route builders).

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
agent **7** · integrations **39**  →  **119 unit tests**, plus anvil e2es
(settle / adapter / agent / integration / **owncast-acceptance**) and a real
Owncast L3 + live MusicBrainz WS/2 validation, all PASS.

## Deployment recipes + gap status (forks now in scope)

`packages/integrations/deploy/<platform>/` — grounded sidecar-attach recipes.
Closed gaps: **#1 Navidrome** (ListenBrainz target), **#2 Mastodon** (campaign
provider), **#4 MusicBrainz resolver** (recording→artist→wallet via WS/2; async
`Resolve`; live-validated). Designed + documented, not yet built: **#3 PeerTube
plugin**, **#5 browser-extension adaptor (payer-side)**. See `deployment-plan.md`
and the per-recipe READMEs.

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
- [ ] Build the L3/L4 acceptance loop for the remaining platforms (Jellyfin/RSSHub/Mastodon).
- [x] Gap #4: `createMusicBrainzResolver` (async `Resolve`) — built + live-validated; wired into Navidrome/Subsonic via `MUSICBRAINZ_USER_AGENT`.
- [x] Real Navidrome L3 (docker) using the resolver: scrobble -> recording_mbid -> artist -> settle. PASS.
- [ ] Gap #5: agent signer abstraction → `@universal-paywall/extension` (MV3).
- [ ] Gap #3: build + publish `peertube-plugin-universal-paywall`.
- [ ] Immich shared-link reverse-proxy variant (out of scope here — no fork).
- [ ] Federation-peer sidecar for Mastodon per-user (`attributedTo`) reshare settlement.
