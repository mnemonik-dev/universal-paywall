# Integration Playbook — Adding a New Platform

A step-by-step instruction doc for attaching the Universal Paywall to a new
platform **without modifying the platform's source**. Work top to bottom:
**(A)** run the questions script to pick the pattern + gather facts, **(B)** build
the adapter, **(C)** wire the rail, **(D)** climb the test ladder, **(E)** check
done. Conceptual background: `../../work/creator-platform-integrations/integration-patterns.md`.

> Everything you build lives in `@universal-paywall/integrations` (creator side) or
> a small companion package (a published plugin / the browser extension). You never
> edit the platform.

---

## A. Discovery — the questions script

Copy this block into an issue and answer every line before writing code. The
answers select the attachment pattern and give you the exact facts to implement it.

### A1. Pattern selection (answer in order; first "yes" wins)

```
Q1. Does the platform let an operator REDIRECT a protocol target by config
    (e.g. an external scrobbler/webhook/storage URL it already speaks to)?
      → YES: PATTERN 1 (existing-config redirect).  Which env/setting? ____
Q2. Does it EMIT webhooks / outbound notifications for the event you want to bill?
      → YES: PATTERN 2 (event subscriber / sidecar).  How is the URL registered? ____
Q3. Can you put a REVERSE PROXY in front of the request whose serving = the billable
    event (asset fetch, page view, download)?
      → YES: PATTERN 3 (wrapper).  Which request path is the billable resolve? ____
Q4. Does it have a PLUGIN LOADER with a hook for the event?
      → YES: PATTERN 4 (published plugin).  Which hook name? ____
Q5. Does it FETCH an external data source you could serve (campaigns, config, feed)?
      → YES: PATTERN 5 (external provider).  Which setting points at the source? ____
Q6. None of the above, or you want to bill platform-agnostically from the client?
      → PATTERN 6 (consumer/payer-side adaptor — browser extension / wrapper client).
```

### A2. Event surface (the billable event)

```
- Trigger event:                ________ (e.g. scrobble, USER_PARTED, PlaybackStop, view)
- Transport + exact shape:      ________ (HTTP route + JSON body, or webhook payload)
- Field carrying CONTENT id:    ________ (mediaFileId / ItemId / video.channelId / assetId)
- Field carrying USER id:       ________ (userId / token / x-payer-user / share key)
- Field carrying AMOUNT inputs: ________ (position ticks, seconds, count — what you bill on)
- Does the platform DEDUPE/throttle the event? (avoid double-charge):  ________
- Auth needed to receive/observe the event:  ________
```

### A3. Identity → wallet (the resolver / moat)

```
- Payer key space:   ________  (who pays — the consumer; how do they identify?)
- Creator key space: ________  (who is paid — content owner/artist/channel/streamer)
- Is there a public registry to map creator-id → canonical identity?
    ________  (e.g. MusicBrainz recording_mbid → artist_mbid)
- id → wallet source: static map first (mapResolver) → managed registry later.
- Fallback when an id is unknown:  meter-and-skip (return null), NEVER mischarge.
```

### A4. Unit of value + price

```
- Unit:   per-listen | per-second | per-minute | per-view | per-citation | per-resolve | per-request
- Price:  ________ micro-USDC per unit
- Amount formula from A2 inputs:  ________  (e.g. floor(ticks / 600_000_000) * rate)
```

### A5. Security / deployment

```
- Reachability: can the platform reach our endpoint (host net / DNS / proxy)?  ____
- Auth on our endpoint (SIDECAR_API_KEY / share key / signature):  ____
- Spend bound: the consumer's on-chain grant CAP + validUntil already bound spend.
```

---

## B. Build — by pattern

All patterns end at the same call:
`reporter.report({ payerKey, creatorKey, amount, ref })` where
`reporter = createReporter({ facilitatorUrl, apiKey, resolvePayer, resolveCreator })`.

### Shared step (every pattern) — the reporter

```ts
import { createReporter, mapResolver } from '@universal-paywall/integrations';
const reporter = createReporter({
  facilitatorUrl: process.env.FACILITATOR_URL!,
  apiKey: process.env.FACILITATOR_API_KEY!,
  resolvePayer: mapResolver(JSON.parse(process.env.PAYER_WALLETS || '{}')),   // A3 payer key → wallet
  resolveCreator: mapResolver(JSON.parse(process.env.CREATOR_WALLETS || '{}')), // A3 creator key → wallet
});
```

### Pattern 1 & 2 & 3 (feeds/proxy) — add an adapter + route in `@universal-paywall/integrations`

1. `src/<platform>.ts`: a pure `handle<Event>(ev, reporter, opts)` that maps the
   A2 fields to `reporter.report(...)` and returns the `ReportOutcome`. Model it on
   `owncast.ts` / `jellyfin.ts` / `subsonic.ts` / `listenbrainz.ts`.
2. `src/serve.ts`: add a `Route` builder (`<platform>Route(reporter, opts)`), or for
   Pattern 1 a protocol endpoint (see `listenBrainzRoutes`), or for Pattern 3 a
   reverse proxy (see `createImmichProxy`).
3. `src/index.ts`: export the new symbols.
4. `src/cli.ts`: add a `case '<platform>':` building the route(s) (or proxy) so
   `PLATFORM=<platform>` runs it via the `up-integration` CLI.
5. `src/__tests__/<platform>.test.ts`: unit-test the adapter + route (spy reporter;
   for HTTP/proxy use `createSidecarServer` / a mock upstream over an ephemeral port).

Reverse-proxy specifics (Pattern 3): match only the billable request, proxy
everything through, meter AFTER a 2xx, look up the creator from the platform's own
API if needed, and **dedupe** repeated sub-requests of one event. See
`immich-proxy.ts`.

### Pattern 4 — a published plugin (separate package)

1. New package `packages/<platform>-plugin/` (model on `packages/peertube-plugin/`).
2. `main.js`: `register({ registerHook, registerSetting, settingsManager })` →
   register the A1/A4 hook → build a reporter from settings → `reporter.report`.
   Take the payer key from a header/session; meter-and-skip unknown payers.
3. **Bundle self-contained** (`esbuild ... --bundle`) so the plugin has no
   unpublished dependency — required for a real install (see the peertube `build`).
4. `test.mjs`: drive `register()` with a mock plugin API + a mock facilitator;
   assert the hook fires a charge with the resolved wallets/price.
5. Publishing (npm / the platform's plugin index) is the only external step.

### Pattern 5 — an external provider

1. `src/<platform>.ts`: `build<Thing>(opts, query)` returning the JSON the platform
   fetches; `src/serve.ts`: a route serving it (echo any per-request fields the
   platform keys its cache on — see Mastodon's `locale`). Use `RouteResponse` for
   non-200 (e.g. 204 "no content").
2. CLI `case`, exports, tests as above. No facilitator needed if it only serves
   config; the money settles later at the `donation_url`/checkout via the agent.

### Pattern 6 — consumer/payer-side adaptor

1. Build on `@universal-paywall/agent` with an **injected account** (never a raw
   key): `createPayerAgent({ rpcUrl, chainId, account, walletTransport?, stakeVaultFactory, usdc })`.
2. Expose `fetchWithPaywall` through your client surface (MV3 message handler +
   bridge — see `packages/extension/`). Gate external callers with an allowlist.

---

## C. Wire the rail (common to all creator-side patterns)

```
consumer (agent)         our adapter            facilitator              rail (contracts)
  pre-stake USDC  ───────────────────────────────────────────────────▶  StakeVault deposit
  grant(facilitator, cap, validUntil) ──────────────────────────────▶  StakeVault.grantPolicy
  (platform event) ──▶ reporter.report ──charge──▶ ledger → batch → settle ──▶ StakeVault.settle
```

- Deploy a `StakeVaultFactory` (`contracts/script/DeployStakeRail.s.sol`).
- Run `up-facilitator` (API key + batch config).
- The consumer stakes + grants via `@universal-paywall/agent` (or `ensureGrant`).
- Your adapter only ever calls `reporter.report` — the rail does custody-free,
  batched, on-chain settlement. No fee in the rail.

Registry (the moat): start with `mapResolver(staticMap)`; graduate to a real
resolver when an id needs canonicalization — see `createMusicBrainzResolver`
(`recording_mbid → artist_mbid → wallet`, async `Resolve`, cached + rate-limited,
unknown → null).

---

## D. Test ladder (climb in order; do not skip)

| Layer | Proves | How |
|---|---|---|
| **L1 Unit** | adapter maps the event → correct charge args | vitest spy reporter |
| **L2 Contract** | the running endpoint answers the platform's real bytes | `createSidecarServer`/proxy + `fetch` over an ephemeral port |
| **L3 Real instance** | a live platform actually drives the event into us | run the upstream Docker image; wire per the recipe |
| **L4 Money loop** | payee on-chain balance += rate × units | anvil + facilitator + `settle`; model on `scripts/e2e-*-live-docker.mjs` |

The universal acceptance check (L4): *after one event from a staked consumer, the
payee's on-chain balance increased by exactly the expected amount.*

L3/L4 harness recipe (reuse the existing scripts):
1. `dockerd` (root) → `docker run` the **upstream** image (GHCR avoids Docker Hub
   anon pull limits). No fork needed — forks are reference-only.
2. anvil + deploy rail + facilitator + your adapter, with `resolvePayer`/`resolveCreator`
   mapped to the real platform ids you observe.
3. Trigger the real event (register the webhook / scrobble / view / resolve…),
   `flushAll()`, assert the payee balance.

CI runs L1+L2 only (hermetic, no Docker/chain). L3+L4 are the per-platform
acceptance gate.

---

## E. Definition of done (checklist)

```
[ ] A. Questions script answered (pattern chosen, event + ids + price + auth captured).
[ ] B. Adapter + route/proxy/plugin/provider built; exported; CLI `PLATFORM=` case added.
[ ] B. Unknown ids meter-and-skip (return null) — never mischarge.
[ ] C. resolvePayer/resolveCreator wired (static map ok; registry if canonicalization needed).
[ ] D. L1 unit tests green.
[ ] D. L2 contract check green (real request/response bytes).
[ ] D. L3 a real upstream instance drove the event into the adapter.
[ ] D. L4 payee paid on-chain = rate × units (committed e2e-<platform>-live-docker.mjs).
[ ] E. Recipe doc: deploy/<platform>/README.md (attach steps + verify) + testing-plan row.
[ ] E. No edit to the platform's source. Any installed artifact is a published plugin / config only.
```

---

## Appendix — reference

**Package surface** (`@universal-paywall/integrations`):
`createReporter`, `mapResolver`, `createMusicBrainzResolver`,
`createSidecarServer`, `RouteResponse`, route builders (`subsonicRoute`,
`owncastRoute`, `jellyfinRoute`, `citationRoute`, `immichRoute`,
`listenBrainzRoutes`, `mastodonCampaignRoute`), `createImmichProxy`, and the
`up-integration` CLI.

**CLI env:** `PLATFORM`, `FACILITATOR_URL`, `FACILITATOR_API_KEY`, `PAYER_WALLETS`,
`CREATOR_WALLETS`, `RATE`, `PORT`, `SIDECAR_API_KEY`; platform-specific:
`STREAMER_KEY` (owncast), `MUSICBRAINZ_USER_AGENT`/`MUSICBRAINZ_BASE_URL` (music),
`UPSTREAM_URL` (immich-proxy), `CAMPAIGN_*` (mastodon).

**Worked examples (copy these):**
| Pattern | File(s) | Live L3 harness |
|---|---|---|
| 1 config-redirect | `src/listenbrainz.ts` | `scripts/e2e-navidrome-live-docker.mjs` |
| 2 event subscriber | `src/owncast.ts`, `src/jellyfin.ts` | `scripts/e2e-owncast-live-docker.mjs`, `e2e-jellyfin-live-docker.mjs` |
| 3 reverse proxy | `src/immich-proxy.ts`, `src/rsshub.ts` | `scripts/e2e-immich-live-docker.mjs`, `e2e-rsshub-live-docker.mjs` |
| 4 published plugin | `packages/peertube-plugin/` | (real install; PeerTube 7.3.0) |
| 5 external provider | `src/mastodon.ts` | `scripts/e2e-mastodon-donation-anvil.mjs` |
| 6 payer adaptor | `packages/extension/` | `packages/extension/e2e-anvil.mjs` |

**Registry/moat example:** `src/musicbrainz.ts` (`createMusicBrainzResolver`).
