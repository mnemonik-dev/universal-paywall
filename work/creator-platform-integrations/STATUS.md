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
agent **7** · integrations **29**  →  **109 unit tests**, plus 4 anvil e2es
(settle / adapter / agent / integration) all PASS.

## Deployment recipes + gap status (forks now in scope)

`packages/integrations/deploy/<platform>/` — grounded sidecar-attach recipes.
Closed gaps: **#1 Navidrome** (ListenBrainz target) and **#2 Mastodon** (campaign
provider). Designed + documented, not yet built: **#3 PeerTube plugin**,
**#4 MusicBrainz resolver**, **#5 browser-extension adaptor (payer-side)**. See
`deployment-plan.md` and the per-recipe READMEs.

## Testing

`testing-plan.md` — four-layer verification per platform (L1 unit → L2 sidecar HTTP
contract → L3 real Docker'd instance → L4 anvil on-chain money loop) + the
per-platform test matrix.

## Remaining / future

- [ ] Build the L3/L4 acceptance loop for each platform (Owncast first; harness proven).
- [ ] Gap #4: `createMusicBrainzResolver` (async `Resolve`) — the moat behind Navidrome.
- [ ] Gap #5: agent signer abstraction → `@universal-paywall/extension` (MV3).
- [ ] Gap #3: build + publish `peertube-plugin-universal-paywall`.
- [ ] Immich shared-link reverse-proxy variant (out of scope here — no fork).
- [ ] Federation-peer sidecar for Mastodon per-user (`attributedTo`) reshare settlement.
