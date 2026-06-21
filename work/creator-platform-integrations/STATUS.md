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
| Music (Subsonic/Navidrome) | `handleScrobble`, `parseSubsonicScrobble` | `subsonicRoute` (GET `/rest/scrobble.view`) | ✓ |
| Live video (Owncast) | `OwncastPresenceMeter` | `owncastRoute` (POST `/owncast`) | ✓ |
| VOD (Jellyfin) | `handleJellyfinEvent` | `jellyfinRoute` (POST `/jellyfin`) | ✓ |
| Feeds (RSSHub) | `handleCitation` | `citationRoute` (POST `/citation`) | ✓ |
| Photo (Immich) | `handleSharedLinkResolve` | `immichRoute` (POST `/immich/resolve`) | ✓ |

- `createSidecarServer(routes)` + `up-integration` CLI: run any sidecar from env
  (`PLATFORM`, `FACILITATOR_URL`, `FACILITATOR_API_KEY`, `PAYER_WALLETS`,
  `CREATOR_WALLETS`, `RATE`, `STREAMER_KEY`, `PORT`, `SIDECAR_API_KEY`).
- **17 unit tests** (core resolver, 5 verticals, route builders).

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
agent **7** · integrations **17**  →  **97 unit tests**, plus 4 anvil e2es
(settle / adapter / agent / integration) all PASS.

## Remaining / future

- [ ] Per-sidecar deployment recipes (Docker) + Owncast/Jellyfin webhook-registration docs.
- [ ] Immich shared-link reverse-proxy variant (access-log tail) for zero-config attach.
- [ ] Real MusicBrainz/EXIF → wallet registry (the moat) beyond `mapResolver`.
- [ ] If repos are authorized + added to scope: publish PeerTube plugin + Mastodon provider.
- [ ] Federation-peer sidecar for Mastodon per-user (`attributedTo`) reshare settlement.
