---
feature: creator-platform-integrations
doc: integration-patterns
question: "how to integrate a paywall WITHOUT touching the platform?"
---

# Integrating a Paywall Without Touching the Platform

The core principle: **attach at a boundary the platform already exposes** — its
config, its outbound events, its request path, its plugin loader, its external-data
slots, or the client — and translate the platform's *existing* event stream into a
metered charge on a shared settlement rail. The platform's source is never modified.

```
platform's existing surface ──event──▶ our adapter ──charge──▶ facilitator ──settle──▶ StakeVault (on-chain)
   (config / webhook / proxy /          (@universal-paywall/      (batches)            (non-custodial)
    plugin / provider / client)          integrations)
```

Every integration here was verified against the **upstream** platform — no fork was
edited (and none was even needed: forks are reference-only).

## The six permissionless attachment patterns

### 1. Existing-config redirect — point the platform's own config at us
The platform already speaks a protocol to some upstream; we implement that protocol
and the operator redirects one config value to us. The platform can't tell.

- **Navidrome (music):** set `ND_LISTENBRAINZ_BASEURL` to our sidecar, which speaks
  the ListenBrainz wire protocol (`GET /1/validate-token`, `POST /1/submit-listens`).
  Navidrome scrobbles to us natively. **Verified:** real scrobble → `recording_mbid`
  → MusicBrainz artist → on-chain settle. Zero Navidrome change.

### 2. Outbound-event subscriber (sidecar) — register for events it already emits
The platform has a webhook/notification mechanism; we register our endpoint.

- **Owncast (live):** register our `/owncast` URL via the admin webhook API for
  `USER_JOINED`/`USER_PARTED`. **Verified:** live stream + real chat join/part → presence bill → settle.
- **Jellyfin (VOD):** install the *official* first-party Webhook plugin, point it at
  `/jellyfin` for `PlaybackStop`. **Verified:** real playback stop → per-minute bill → settle.

### 3. Reverse proxy / wrapper — sit in the request path, never inside the app
Put a transparent proxy in front; observe the requests that matter and meter them.

- **Immich (photo):** `createImmichProxy` proxies to Immich and, on each external
  shared-link asset resolve (`GET /api/assets/:id/original?key=…`), looks up the
  owner via the asset API and bills a license fee. **Verified:** real shared link
  resolved through the proxy → image streams through → owner paid on-chain.
- **RSSHub (feeds):** the crawler boundary (or an operator middleware) reports a
  citation when an answer is grounded in a fetched item. **Verified:** live RSSHub item → toll → settle.

### 4. Published plugin — fill the platform's sanctioned plugin slot
Where the platform has a plugin loader, ship a *published* plugin (not a core edit);
the operator installs it.

- **PeerTube (federated VOD):** `peertube-plugin-universal-paywall` registers the
  `action:api.video.viewed` server hook → charge. **Verified:** installs, registers
  the hook + settings, enabled, configurable on real PeerTube 7.3.0 (self-contained
  bundle so it has no unpublished dependency).

### 5. External provider — serve the data the platform fetches
The platform fetches an external source; we run that source.

- **Mastodon (fediverse):** the instance points `DONATION_CAMPAIGNS_URL` at our
  provider; Mastodon fetches + caches our campaign JSON; the `donation_url` routes
  through the rail. **Verified:** provider campaign → donation → on-chain settle to the instance.

### 6. Consumer/payer-side adaptor — nothing on the platform at all
Pay on the *user's* behalf from the client.

- **Browser extension** (`@universal-paywall/extension`, MV3): auto-pays x402
  paywalls via the payer agent; other extensions/pages request paid fetches via a
  message bridge. **Verified (headless E2E):** `upFetch` → 402 → grant → 200 → settle.

## What makes this work (the cross-cutting pieces)

- **A protocol/event adapter per surface** (`@universal-paywall/integrations`) that
  turns a platform-native event (scrobble / webhook / proxied request / hook /
  fetch) into `reporter.report({ payer, creator, amount })`.
- **A settlement rail** (`@universal-paywall/facilitator` + `StakeVault`): the
  consumer pre-stakes USDC and grants a bounded, time-limited policy; the
  facilitator batches metered charges and settles direct to creators on-chain —
  non-custodial, no protocol rent, no fee in the rail.
- **A resolver registry (the moat):** `resolvePayer` / `resolveCreator` map a
  platform-native id → wallet (e.g. MusicBrainz `recording_mbid → artist_mbid →
  wallet`, live-validated). Unknown ids are metered-and-skipped, never charged wrong.

## Why not just submit a PR to the platform?

For #1–#6 a core PR is the *wrong* shape — a permissionless attachment needs no
upstream change. Empirically, upstreams merge server-admin donation pointers but
reject per-user payment plumbing, so the durable integration is one you ship
yourself at a boundary the platform already exposes. The only artifacts the operator
installs (Jellyfin webhook plugin, PeerTube plugin) are *published* into sanctioned
extension points — still not edits to the platform's source.

## Decision guide — pick the attachment for a new platform

1. Does it let you **redirect a protocol target** by config? → Pattern 1 (cleanest).
2. Does it **emit webhooks/notifications**? → Pattern 2 (sidecar subscriber).
3. Can you **proxy its asset/serving requests**? → Pattern 3 (wrapper).
4. Does it have a **plugin loader**? → Pattern 4 (published plugin).
5. Does it **fetch an external source** you can serve? → Pattern 5 (provider).
6. None of the above, or you want to pay platform-agnostically? → Pattern 6 (client adaptor).

Then: map its content/user ids to wallets in the resolver, point the consumer's
stake/grant at the facilitator, and the rail settles each metered event on-chain.
