---
feature: creator-platform-integrations
doc: platforms
created: 2026-06-17
---

# Platform List & Integration Patterns

Platforms named in the Canteen essay, the event surface each exposes, the
attachment shape, how it maps to the Universal Paywall rail, and whether a PR is
the integration path.

Legend — **Pattern**: Sidecar (external process on the platform's public API),
Plugin (upstream plugin loader), Wrapper (reverse-proxy / access-log tail),
Provider (fills an upstream-sanctioned external slot). **Payer** = consumer who
pre-staked via `@universal-paywall/agent`; **Creator** = resolved payee.

## The four cleanest (per-event) — implemented in `packages/integrations/`

| # | Vertical | Anchor repo | Event surface | Pattern | Unit of value | PR to upstream? |
|---|---|---|---|---|---|---|
| 1 | Music | [navidrome/navidrome](https://github.com/navidrome/navidrome) (+ Subsonic family: gonic, ampache, airsonic, …) | Subsonic `scrobble.view` / `scrobbles` table (`mediaFileId`, `userId`, `timestamp`) | **Sidecar** (external scrobbler, proxy, or SQLite tail) | per-listen royalty | **No** — permissionless |
| 2 | Live video | [owncast/owncast](https://github.com/owncast/owncast) | `userJoined` / `userParted` webhooks | **Sidecar** (webhook subscriber) | per-second presence | **No** — permissionless |
| 3 | VOD | [jellyfin/jellyfin](https://github.com/jellyfin/jellyfin) | official [Webhook plugin](https://github.com/jellyfin/jellyfin-plugin-webhook): `PlaybackProgress` / `PlaybackStop` | **Sidecar** (subscribe to the existing plugin's HTTP posts) | per-minute | **No** — uses the official plugin |
| 4 | Feeds | [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) | `DataItem.link` + `DataItem.author` | **Wrapper/Middleware** (RSSHub middleware or LLM-crawler boundary) | per-citation toll | **No** — permissionless |

Each maps to: `resolvePayer(userId|crawlerId) → payerWallet`, `resolveCreator(mediaFileId|artistMBID|authorUrl|streamerId) → payeeWallet`, then `sdk.charge({ payer, creator, amount, ref })`. The resolvers are the **registry/moat**.

## Plugin / provider verticals — drafts + upstream path (no auto-PR)

| # | Vertical | Anchor | Slot | Pattern | Integration path |
|---|---|---|---|---|---|
| 5 | Federated VOD | [Chocobozzz/PeerTube](https://github.com/Chocobozzz/PeerTube) | plugin loader; [`req.rawBody` PR #6300](https://github.com/Chocobozzz/PeerTube/pull/6300) enabled Stripe-style webhooks; [#1586](https://github.com/Chocobozzz/PeerTube/issues/1586) 7-yr demand | **Plugin** | Publish a `peertube-plugin-universal-paywall` to the plugin marketplace; on a view event, call the facilitator. *Not a core PR — a published plugin.* |
| 6 | Fediverse fundraising | [mastodon/mastodon](https://github.com/mastodon/mastodon) | `GET /api/v1/donation_campaigns` ([#37880](https://github.com/mastodon/mastodon/pull/37880), merged) | **Provider** | Run an external campaign-source service the instance points at. *Fills a sanctioned slot — no core PR.* |
| 7 | Photo | [immich-app/immich](https://github.com/immich-app/immich) | `GET /shared-link/:id` controller; `ownerId` + EXIF `Artist` | **Wrapper** (reverse-proxy / access-log tail) | Per-resolve license fee to the EXIF Artist; coexists with Immich's own license program (different value chain). Sidecar — no PR. |

## Consumer / payer-side vertical

| # | Vertical | Anchor | Slot | Pattern | Integration path |
|---|---|---|---|---|---|
| 8 | Browser extension (**payer-side**) | any WebExtension (Chrome/Firefox MV3) | `@universal-paywall/agent.fetchWithPaywall` | **Adaptor** | Publish `@universal-paywall/extension`: a background service worker hosts the payer agent; other extensions/pages request paid fetches via `onMessageExternal` / a page bridge. Auto-pays the paywalls the creator sidecars meter. **Prereq:** agent signer abstraction (no raw key in an extension). Design: `../../packages/integrations/deploy/browser-extension/README.md`. |

## Not our model (permissioned by design)

- **Podcasting** ([Castopod](https://github.com/ad-aures/castopod), [AntennaPod](https://github.com/AntennaPod/AntennaPod)) — Podcasting 2.0 `<podcast:value>` carries wallet routing in the feed XML itself; payment is protocol-level, not a sidecar attachment.
- **Publishing** ([Ghost](https://github.com/TryGhost/Ghost)) — payment-native by design (Stripe Members); no attachment point needed.

## Why no PRs are being opened from here

1. **Permissionless is the article's whole point** — for #1–4 and #7 a PR is the *wrong* shape; a sidecar attaches without touching upstream.
2. **Upstreams reject per-user payment plumbing** — only server-admin donation pointers merge (PeerTube/Mastodon/Immich histories).
3. **Scope** — this environment's GitHub is restricted to `mnemonik-dev/universal-paywall`; opening PRs against external repos is out of scope and requires explicit maintainer + user authorization.

So: sidecars are implemented and runnable here; plugin/provider drafts are PR-ready with the exact upstream path documented above.
