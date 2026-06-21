---
feature: creator-platform-integrations
doc: upstream-integration-guide
created: 2026-06-17
audience: a future session that has the external platform repos available
---

# Upstream Integration Guide (next session, with platform repos)

Everything needed to take the integrations from "runnable in our repo" to "wired
into the real platforms" — including how to get the platform repos into scope, the
exact attachment point per platform, the concrete steps, verification, and the
PR/publish process.

Read `../HANDOFF.md` first for the overall state + environment bootstrap.

## 0. Prerequisites for the next session

1. **Bootstrap the env** per `../HANDOFF.md` (Foundry, solc, submodules, gitleaks,
   `npm install`). Confirm `npm test` (all packages) + the 4 anvil e2es pass.
2. **Base branch:** continue from `feat/creator-platform-integrations` (it has the
   full rail + sidecars). Create per-platform branches `feat/integ-<platform>`.
3. **Our building blocks** (already built and tested):
   - `@universal-paywall/integrations` — `createReporter`, the per-vertical
     adapters, `createSidecarServer` + route builders, the `up-integration` CLI.
   - `@universal-paywall/sdk` — the charge client a sidecar/plugin calls.
   - `@universal-paywall/agent` — the consumer-side stake/grant + `fetchWithPaywall`.
   - A deployed `StakeVaultFactory` (run `contracts/script/DeployStakeRail.s.sol`)
     and a running facilitator (`up-facilitator`).

## 1. Getting the platform repos into scope

This session's GitHub MCP is scoped to `mnemonik-dev/universal-paywall` only.
External repos (navidrome, owncast, jellyfin, peertube, mastodon, immich, rsshub)
are **not** reachable until added.

```
# discover what the remote environment can access
mcp__claude-code-remote__list_repos        # (load via ToolSearch if not present)
# add the ones you need
add_repo  navidrome/navidrome   # etc.
```

If a repo isn't in `list_repos`, it can't be added from here — you'd fork it under
an org you control (or work locally) and push there. **Do not open unsolicited PRs
into upstream projects without explicit maintainer + user sign-off** (the article's
evidence: upstreams merge server-admin donation pointers but reject per-user payment
plumbing).

## 2. Per-platform playbook

For every platform the mapping is the same: `resolvePayer(userId) → payer wallet`
(the consumer who staked via `@universal-paywall/agent`), `resolveCreator(contentKey)
→ payee wallet`, then `sdk.charge()`. The platform-specific work is only **how you
observe the event**.

### Music — Navidrome / Subsonic family  (sidecar, no PR)
- **Repo:** `navidrome/navidrome` (+ gonic, ampache, airsonic). **Anchor:**
  `model/scrobble.go`, `persistence/scrobble_repository.go`, the Subsonic
  `scrobble.view` endpoint, the SQLite `scrobbles` table.
- **Mechanism (pick one):**
  1. **External scrobbler** — Navidrome plugs out to Last.fm/ListenBrainz; register
     our endpoint as an additional scrobble target (see `plugins/scrobbler_adapter.go`).
  2. **Proxy** the `scrobble.view` requests → our `subsonicRoute` (GET).
  3. **Tail** the SQLite `scrobbles` table and replay rows to `handleScrobble`.
- **Use:** `up-integration` with `PLATFORM=subsonic`, or `subsonicRoute(reporter, {ratePerPlay})`.
- **Verify:** `docker run navidrome`, play a track (or hit `scrobble.view`), confirm
  a `charge` reaches the facilitator and settles on anvil.
- **PR?** No — permissionless sidecar.

### Live video — Owncast  (sidecar, no PR)
- **Repo:** `owncast/owncast`. **Anchor:** `services/webhooks/webhooks.go`
  (`userJoined`/`userParted`), `services/stream/stats.go` (15s prune).
- **Mechanism:** register our `/owncast` endpoint in Owncast's **webhook admin UI**
  (or `POST /api/admin/webhooks`) subscribed to USER_JOINED/USER_PARTED.
- **Use:** `PLATFORM=owncast STREAMER_KEY=... RATE=<per-second>` → `owncastRoute(OwncastPresenceMeter)`.
- **Verify:** `docker run owncast`, register the webhook, join/leave as a viewer,
  confirm `(parted-joined)*rate` settles. (Proven on anvil already.)
- **PR?** No.

### VOD — Jellyfin  (sidecar via official plugin, no PR)
- **Repo:** `jellyfin/jellyfin` + `jellyfin/jellyfin-plugin-webhook`. **Anchor:**
  `Jellyfin.Api/Controllers/PlaystateController.cs`; the Webhook plugin's
  `PlaybackProgressNotifier`/`PlaybackStopNotifier`.
- **Mechanism:** install the **official Jellyfin Webhook plugin**, point it at our
  `/jellyfin` endpoint, template the payload to include `NotificationType`,
  `UserId`, `ItemId`, `PlaybackPositionTicks`.
- **Use:** `PLATFORM=jellyfin RATE=<per-minute>` → `jellyfinRoute`. We bill on
  `PlaybackStop` (whole minutes from final position).
- **Verify:** `docker run jellyfin`, install webhook plugin, play+stop, confirm minutes settle.
- **PR?** No — uses the existing plugin.

### Feeds — RSSHub / LLM crawler  (middleware or crawler-side, no PR)
- **Repo:** `DIYgod/RSSHub`. **Anchor:** `lib/types.ts` (`DataItem.link`/`author`),
  `lib/middleware/`.
- **Mechanism (prefer the crawler boundary):** in an LLM crawler/agent, when an
  answer is grounded in a source URL, call our `/citation` endpoint (or
  `handleCitation`) with `{ crawlerId, link, author }`. Alternatively inject RSSHub
  middleware that stamps an `x-payment` attribution token per item.
- **Use:** `PLATFORM=rsshub RATE=<per-citation>` → `citationRoute`.
- **Verify:** run RSSHub, fetch a feed, simulate a citation event → settle.
- **PR?** No — ship inside the crawler framework.

### Photo — Immich  (reverse-proxy / access-log wrapper, no PR)
- **Repo:** `immich-app/immich`. **Anchor:** `server/src/controllers/shared-link.controller.ts`
  (`GET /shared-link/:id`); `Asset.ownerId` + EXIF `Artist`.
- **Mechanism:** put a reverse proxy / access-log tail in front of
  `GET /shared-link/:id`; on each external resolve, look up EXIF `Artist`
  (fallback `ownerId`) and call our `/immich/resolve` endpoint (or
  `handleSharedLinkResolve`). Note Immich has its OWN supporter "license" program —
  ours is a **different value chain** (photographer-paid), so it coexists.
- **Use:** `PLATFORM=immich RATE=<per-resolve>` → `immichRoute`.
- **TODO:** the reverse-proxy variant (auto-tail) isn't built yet — only the
  event handler/route. Build it next to this guide.
- **PR?** No.

### Federated VOD — PeerTube  (PUBLISH a plugin — not a core PR)
- **Repo:** `Chocobozzz/PeerTube`. **Context:** plugin loader; `req.rawBody`
  [PR #6300](https://github.com/Chocobozzz/PeerTube/pull/6300) enabled Stripe-style
  webhooks; 7-year demand in [#1586](https://github.com/Chocobozzz/PeerTube/issues/1586).
- **Mechanism:** scaffold `peertube-plugin-universal-paywall` (see
  `pr-drafts.md` for a working `main.js` registering `action:api.video.viewed` →
  `reporter.report`). Publish to npm / the PeerTube plugin index. The operator
  installs it and configures facilitator URL + wallet maps via plugin settings.
- **Verify:** `docker run peertube`, install the local plugin, view a video, confirm settle.
- **PR?** Publish a plugin (not a core PR). Optionally PR docs/examples upstream.

### Fediverse — Mastodon  (run a PROVIDER — not a core PR)
- **Repo:** `mastodon/mastodon`. **Context:** `GET /api/v1/donation_campaigns`
  ([#37880](https://github.com/mastodon/mastodon/pull/37880), merged) fetches+caches
  an EXTERNAL campaign source; companion banner UI
  [#36102](https://github.com/mastodon/mastodon/pull/36102) still open.
- **Mechanism:** run the campaign-source service (draft in `pr-drafts.md`); the
  instance operator points Mastodon's donation-campaigns fetch at it. "Donations"
  settle through our rail (onchain-transparent), per-instance configurable.
- **Per-user creator payments** (paying an author for a popular post / reshare) is a
  separate **federation-peer sidecar** observing the public `attributedTo` activity
  stream — a later vertical, also permissionless.
- **PR?** No — fill the sanctioned external slot; optionally contribute to #36102.

## 3. Not our model (skip)
- **Podcasting** (Castopod/AntennaPod) — Podcasting 2.0 `<podcast:value>` puts wallet
  routing in the feed XML; protocol-level, not a sidecar.
- **Ghost** — payment-native by design.

## 4. Definition of done per platform
1. A running sidecar/plugin/provider observing real events from a real instance.
2. A consumer that staked + granted via `@universal-paywall/agent`.
3. An observed event → `charge` → facilitator batch → on-chain `settle` → payee paid.
4. The wallet **registry** populated for that platform's identities (the moat).
5. Docs: how an operator installs + configures it; a Docker/compose recipe.

## 5. Cross-cutting TODOs that unblock all platforms
- Real `resolvePayer`/`resolveCreator` **registry** (MusicBrainz MBID, EXIF Artist,
  ActivityPub actor, author URL → wallet) — currently `mapResolver(staticMap)`.
- Hosted facilitator + deployed `StakeVaultFactory` on a real testnet (Arc) so
  sidecars settle against a live chain, not anvil.
- A consumer onboarding flow (stake + grant) usable by non-developers.
