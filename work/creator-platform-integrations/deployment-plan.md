---
feature: creator-platform-integrations
doc: deployment-plan
created: 2026-06-21
supersedes: parts of upstream-integration-guide.md (now that the forks are in scope)
decision: "sidecars + recipes only; platform forks stay untouched"
sequencing: "plan + scaffold first, then build one platform at a time"
---

# Deployment Plan — Attaching the Rail to the In-Scope Platform Forks

This session has the platform forks in scope as `mnemonik-dev` clones
(`navidrome`, `owncast`, `jellyfin`, `RSSHub`, `PeerTube`, `mastodon`,
`musicbrainz-server`). The chosen integration shape is **sidecars + deployment
recipes only** — we do **not** modify the platform forks. Each platform attaches
to the existing `@universal-paywall/integrations` sidecar through its own
*existing* configuration surface, which has now been **verified against the actual
fork code** (not just the Canteen guide's assumptions).

> Immich is **not** in scope (no fork) — its row is dropped from this plan.
> Podcasting (Castopod) and Ghost remain out-of-model (payment is protocol-/
> product-native; nothing to attach).

## Verified attachment surface per platform

Every anchor below was confirmed by reading the fork on branch
`claude/universal-paywall-integrations-2xsjwu`.

| Platform | Fork anchor (verified) | Existing config surface used | Sidecar role | Code change to fork? |
|---|---|---|---|---|
| **Navidrome** (music) | `consts/consts.go:82` `DefaultListenBrainzBaseURL = "https://api.listenbrainz.org/1/"`; `core/scrobbler/` external-scrobbler interface | Point `ND_LISTENBRAINZ_BASEURL` at our sidecar's `/1/` | ListenBrainz-compatible scrobble receiver | **None** (config only) |
| **Owncast** (live) | `models/eventType.go:10-12` `USER_JOINED`/`USER_PARTED`; `POST /api/admin/webhooks/create` (`webserver/handlers/generated/generated.gen.go:568`) | Admin webhook registration (Basic auth) | Presence meter (per-second) — already e2e-proven | **None** (register webhook) |
| **Jellyfin** (VOD) | `Jellyfin.Api/Controllers/PlaystateController.cs`; official `jellyfin-plugin-webhook` (separate repo) | Install the official Webhook plugin, template payload | Per-minute billing on `PlaybackStop` | **None** (official plugin) |
| **RSSHub** (feeds) | `lib/types.ts:37,88` `DataItem.link`/`author`; `lib/middleware/` | Crawler boundary (preferred) or an RSSHub middleware | Per-citation toll | **None** (crawler-side) |
| **PeerTube** (fed. VOD) | `packages/models/src/plugins/server/server-hook.model.ts:186` `action:api.video.viewed` | Plugin loader (**no native view webhook exists** — confirmed) | Per-view charge | **Published plugin** (separate npm pkg; not a fork edit) |
| **Mastodon** (fediverse) | `app/controllers/api/v1/donation_campaigns_controller.rb`; `config/mastodon.yml:7` `DONATION_CAMPAIGNS_URL` | Operator sets `DONATION_CAMPAIGNS_URL` → our provider | Campaign-source provider | **None** (env config) |
| **MusicBrainz** (registry) | `musicbrainz-server` WS/2 (`/ws/2/recording/<mbid>`) | Read-only lookups to enrich the resolver | Registry/moat enrichment for `resolveCreator` | **None** (read API) |

## What the sidecar already does vs. what each recipe needs

`@universal-paywall/integrations` ships the `up-integration` CLI (default port
`:8410`, env `PLATFORM|FACILITATOR_URL|FACILITATOR_API_KEY|PAYER_WALLETS|CREATOR_WALLETS|RATE|STREAMER_KEY|PORT|SIDECAR_API_KEY`)
with routes for `subsonic|navidrome|owncast|jellyfin|rsshub|immich|mastodon`.

Gaps the recipes expose:

1. ~~**Navidrome ListenBrainz-target mode**~~ — **CLOSED.** The sidecar now exposes
   `GET /1/validate-token` + `POST /1/submit-listens` (`src/listenbrainz.ts`,
   `listenBrainzRoutes`, `PLATFORM=navidrome`), verified against
   `navidrome/adapters/listenbrainz/client.go`. Token → payer, `recording_mbid`
   (fallback first `artist_mbids`) → creator; `playing_now` skipped. +7 unit tests.
2. ~~**Mastodon provider**~~ — **CLOSED.** The sidecar now serves
   `GET /api/v1/donation_campaigns` (`src/mastodon.ts`, `mastodonCampaignRoute`,
   `PLATFORM=mastodon`): 200 campaign JSON echoing the requested `locale`, or 204
   when unset. Built to the real schema (`amounts` nested `{one_time,monthly}`;
   the stale `pr-drafts.md` array shape corrected), verified against the controller
   + request spec and live HTTP-smoke-tested. No facilitator needed (config-only).
   +5 unit tests. `RouteResponse` added to `serve.ts` for the 204 path.
3. ~~**PeerTube plugin**~~ — **BUILT.** `packages/peertube-plugin/`
   (`peertube-plugin-universal-paywall`): `main.js` registers
   `action:api.video.viewed` → settings-driven `createReporter` → facilitator
   charge. Tested (`node test.mjs`, 9 assertions): hook fires a charge with the
   resolved viewer/channel wallets + configured price; anonymous/unconfigured →
   no charge. Only **publishing** (npm / the PeerTube index) is external.
4. ~~**MusicBrainz resolver**~~ — **CLOSED.** `createMusicBrainzResolver`
   (`src/musicbrainz.ts`): `recording_mbid → artist_mbid` via WS/2
   (`/recording?inc=artists`) → `artist_mbid → wallet`, cached + rate-limited,
   never throws. Made `Resolve` async (`core.ts`); wired into the Navidrome/Subsonic
   CLI via `MUSICBRAINZ_USER_AGENT`. +8 unit tests and **live-validated against the
   public WS/2** (real recording → John Lennon → wallet; cache + unknown paths).
5. ~~**Browser-extension adaptor (payer-side)**~~ — **BUILT.** Prerequisite done:
   the agent now accepts an injected `account` (+ `walletTransport`) instead of a
   raw `payerKey` (`@universal-paywall/agent`, +4 tests). `packages/extension/`
   (`@universal-paywall/extension`, MV3): tested core message handler over the agent
   (`up:status`/`up:ensureGrant`/`up:fetch`), a bridge client, page/external
   wiring, manifest, and a signer model that refuses to run without an injected
   account. `node test.mjs` — 13 assertions. Only store-publishing is external.

## Recipe scaffold (this session's deliverable)

`packages/integrations/deploy/<platform>/` — one folder per platform, each with a
`README.md` (verified attach steps + verification) and a `docker-compose.yml`
skeleton wiring the platform + sidecar + facilitator. Registration helpers
(`register-webhook.sh` for Owncast) are stubbed. These are **scaffolds**: compose
images and env are grounded, but per-instance wallet maps and the gap-routes above
are marked `TODO`.

## Definition of done per platform (carried from the guide)

1. Running platform instance + sidecar observing real events.
2. A consumer that staked + granted via `@universal-paywall/agent`.
3. Observed event → `charge` → facilitator batch → on-chain `settle` → payee paid.
4. Wallet registry populated for that platform's identity space (the moat).
5. Operator install/configure docs + the compose recipe.

## How each integration is tested

See **`testing-plan.md`** for the four-layer verification (L1 unit → L2 sidecar
HTTP contract → L3 real Docker'd instance → L4 anvil on-chain money loop) and the
per-platform test matrix. The universal acceptance check: *after one event from a
staked consumer, the payee's on-chain balance increased by exactly rate × units.*

## Recommended build order

Routes #1 (Navidrome) and #2 (Mastodon) are **done**. Remaining:

1. **Owncast** — already e2e-proven; recipe is pure config (webhook register). Do the
   real-instance L3/L4 acceptance first to validate the whole harness.
2. **Navidrome** — wire `MusicBrainz resolver` (gap #4) as `resolveCreator`, then
   L3/L4 by pointing `ND_LISTENBRAINZ_BASEURL` at the sidecar and playing a track.
3. **MusicBrainz resolver** (gap #4) — unblocks Navidrome's payout; self-contained.
4. **Jellyfin** — install official webhook plugin; verify play→stop billing.
5. **RSSHub** — citation toll at the crawler boundary.
6. **Mastodon** — provider built; do the donation-flow L4 via the agent loop.
7. **Browser-extension** (gap #5) — first add the agent signer abstraction
   (prerequisite), then the MV3 adaptor.
8. **PeerTube** — build the plugin package; publish is external.

