# Platform Integration — Action List

**Purpose:** one place that says, for each target platform, *exactly what "integrate
the Universal Paywall" means* — the attachment pattern, the operator action, the
billable event, how the creator's wallet is resolved, the developer work required,
and the acceptance bar. Review this and mark the platforms to proceed with.

> **Read this first — there is no single "paywall plugin."** The paywall is the
> **rail** (`StakeVault` + facilitator, non-custodial, feeless, on-chain). Per
> platform we build the *smallest adapter* that turns that platform's own event
> into a metered charge. **We never edit the platform's source.** For most
> platforms the operator installs no code at all — they flip a config value or put
> our proxy in the request path. Only PeerTube and WordPress are literally "install
> a plugin."

## Legend

- **Pattern** (from `work/creator-platform-integrations/integration-patterns.md`):
  1 = config-redirect · 2 = event-webhook sidecar · 3 = reverse-proxy · 4 = published
  plugin · 5 = external provider · 6 = payer-side client.
- **Operator action** = the single thing a platform owner does to "integrate" — this
  is what the phrase actually means for that platform.
- **Effort** = net-new developer work (adapter/plugin), *not* counting booting the
  Docker image for L3.
- **Acceptance bar** for "integrated / done" (same for every platform): L1 unit +
  L2 HTTP contract + **L3** real upstream instance drives the event + **L4** payee's
  on-chain balance increases by `rate × units`. See `testing-plan.md`.

## Status snapshot (already integrated — for reference)

| Platform | Pattern | Status |
|---|---|---|
| Owncast (live video) | 2 | L3+L4 PASS |
| Navidrome (music) | 1 | L3+L4 PASS |
| Jellyfin (VOD) | 2 | L3+L4 PASS |
| RSSHub (feeds) | 3 | L3+L4 PASS |
| Immich (photos) | 3 | L3+L4 PASS |
| Mastodon (fediverse) | 5 | L3 (real-docker) + donation-L4 PASS |
| PeerTube (federated VOD) | 4 | Published plugin; installs/registers on real 7.3.0 |
| Browser extension (payer) | 6 | Headless + browser E2E PASS |

Subsonic reverse-proxy (`subsonic-proxy.ts`) and its live-docker harness already
exist from PR #7 — the Subsonic family is mostly a "boot + verify" task, not new code.

---

# Targets

Grouped by effort. Each entry is a checklist of the concrete actions to integrate
that platform.

## Wave 1 — reuse existing adapters (fast; proves the adapters generalize)

### Subsonic family (gonic, airsonic-advanced, ampache, supysonic)
- **Pattern:** 1 (config-redirect) or 3 (reverse-proxy).
- **Operator action:** point the Subsonic client / scrobble target at our sidecar,
  **or** run `subsonic-proxy` in front of the server; clients hit the proxy URL.
- **Billable event:** a track scrobble (`GET /rest/scrobble.view?...&submission!=false`).
- **Creator resolver:** `mediaFileId` / MusicBrainz id → artist wallet
  (`mapResolver`, or `createMusicBrainzResolver` for canonical MBID).
- **Unit / price:** per-listen royalty (micro-USDC per listen).
- **Developer work:** **~none** — `subsonic.ts` + `subsonic-proxy.ts` exist. Confirm
  each server's Subsonic dialect quirks.
- **Actions:**
  - [ ] Boot `sentriz/gonic` (and/or `airsonic/airsonic-advanced`) in Docker.
  - [ ] Put `subsonic-proxy` in front (or redirect the client) and load a track.
  - [ ] L3: real scrobble reaches the sidecar; L4: artist paid on anvil.
  - [ ] Recipe: `deploy/subsonic/README.md` + testing-plan row.
- **Blockers/notes:** none. Lowest-risk win; proves the "Subsonic family" claim.

### Funkwhale (federated music)
- **Pattern:** 1 (config-redirect).
- **Operator action:** Funkwhale speaks the Subsonic API and can scrobble to
  ListenBrainz — point that target at our sidecar.
- **Billable event:** listen / scrobble submission.
- **Creator resolver:** track/recording MBID → artist wallet.
- **Unit / price:** per-listen.
- **Developer work:** reuse `listenbrainz.ts` / `subsonic.ts`; verify Funkwhale's
  wire dialect (it can differ subtly from Navidrome).
- **Actions:**
  - [ ] Boot `funkwhale/all-in-one` (or the compose stack) in Docker.
  - [ ] Redirect its Subsonic/ListenBrainz target to the sidecar.
  - [ ] L3 real listen → L4 artist paid.
  - [ ] Recipe: `deploy/funkwhale/README.md` + testing-plan row.
- **Blockers/notes:** Funkwhale image is heavier (multi-service). Federation is a
  bonus, not required for the money loop.

### Emby (VOD)
- **Pattern:** 2 (event-webhook sidecar).
- **Operator action:** enable Emby's built-in **Webhooks**, point it at our sidecar.
- **Billable event:** `playback.stop` (Emby webhook payload).
- **Creator resolver:** `ItemId` → content-owner wallet.
- **Unit / price:** per-minute watched (`floor(minutes) × rate`).
- **Developer work:** **thin new adapter** — Emby's webhook JSON differs from
  Jellyfin's; model `emby.ts` on `jellyfin.ts`, remap fields.
- **Actions:**
  - [ ] Boot `emby/embyserver` (or `lscr.io/linuxserver/emby`) in Docker.
  - [ ] Build `emby.ts` + `embyRoute` + CLI case + exports + L1/L2 tests.
  - [ ] Enable Emby Webhooks → sidecar; real playback-stop.
  - [ ] L3 real event → L4 owner paid.
  - [ ] Recipe: `deploy/emby/README.md` + testing-plan row.
- **Blockers/notes:** some Emby webhook features are Emby Premiere-gated; confirm the
  free build emits `playback.stop`.

### PhotoPrism (photos)
- **Pattern:** 3 (reverse-proxy).
- **Operator action:** run our proxy in front; meter shared-album asset fetches.
- **Billable event:** external resolve of a shared photo/original.
- **Creator resolver:** album owner / EXIF `Artist` → wallet.
- **Unit / price:** per-resolve license fee.
- **Developer work:** new `photoprism-proxy.ts` **modeled on** `immich-proxy.ts`
  (match only the billable asset path, meter after 2xx, dedupe sub-requests).
- **Actions:**
  - [ ] Boot `photoprism/photoprism` in Docker; create a shared album.
  - [ ] Build `photoprism-proxy.ts` + CLI case + exports + L1/L2 tests.
  - [ ] Resolve a shared asset through the proxy.
  - [ ] L3 real resolve → L4 owner paid.
  - [ ] Recipe: `deploy/photoprism/README.md` + testing-plan row.
- **Blockers/notes:** identify the exact shared-link asset path (differs from Immich).

## Wave 2 — net-new adapters, existing patterns

### Plex (VOD, largest install base)
- **Pattern:** 2 (event-webhook sidecar).
- **Operator action:** add our URL under Plex **Settings → Webhooks**.
- **Billable event:** `media.stop` / `media.scrobble` (multipart form: JSON `payload`
  part + optional thumb).
- **Creator resolver:** `Metadata.grandparentTitle`/`ratingKey` → owner wallet.
- **Unit / price:** per-minute (from `viewOffset`) or per-play.
- **Developer work:** new `plex.ts` — parse Plex's multipart webhook, remap fields.
- **Actions:**
  - [ ] Boot `plexinc/pms-docker` in Docker.
  - [ ] Build `plex.ts` + `plexRoute` (multipart parse) + CLI case + tests.
  - [ ] Register the webhook; drive a real play/stop.
  - [ ] L3 real event → L4 owner paid.
  - [ ] Recipe: `deploy/plex/README.md` + testing-plan row.
- **Blockers/notes:** **Plex webhooks require Plex Pass.** Without a Plex Pass token
  the live L3 can't fire — fall back to L1/L2 (byte-exact multipart fixture) + L4
  anvil, and document the token requirement. Flag this before committing time.

### Nextcloud (files / shares — huge self-host base)
- **Pattern:** 2 (webhook) or 3 (reverse-proxy). Pick one after a spike.
- **Operator action:**
  - *Pattern 2:* enable the built-in **webhook_listeners** app and register our URL
    for the file-access event; **or**
  - *Pattern 3:* proxy public share downloads (`/s/<token>/download`).
- **Billable event:** public-share file download (proxy) or a file-access webhook.
- **Creator resolver:** share owner (uid) → wallet.
- **Unit / price:** per-download license fee.
- **Developer work:** new adapter for whichever surface wins — proxy is more reliable
  for a clean "billable download" boundary.
- **Actions:**
  - [ ] Boot `nextcloud` (+ db) in Docker; create a public share.
  - [ ] Spike both surfaces; choose Pattern 2 vs 3.
  - [ ] Build `nextcloud[-proxy].ts` + CLI case + tests.
  - [ ] L3 real download/webhook → L4 owner paid.
  - [ ] Recipe: `deploy/nextcloud/README.md` + testing-plan row.
- **Blockers/notes:** webhook_listeners event granularity varies by version; the
  proxy path is the safer bet.

## Wave 3 — published plugin (heaviest; new language/package)

### WordPress (largest CMS)
- **Pattern:** 4 (published plugin).
- **Operator action:** install our plugin from the WP admin, set wallet + price.
- **Billable event:** paywalled post view / `template_redirect` on gated content
  (or a WooCommerce checkout for one-off unlocks).
- **Creator resolver:** author/site wallet from plugin settings.
- **Unit / price:** per-view or per-unlock.
- **Developer work:** **new PHP package** `packages/wordpress-plugin/` — a real
  WordPress plugin (PHP), analogous to `packages/peertube-plugin/` but not JS. On the
  hook, call the facilitator (`reporter.report`). Bundle self-contained.
- **Actions:**
  - [ ] Scaffold `packages/wordpress-plugin/` (PHP: `plugin.php` + hook + settings).
  - [ ] Hook `template_redirect`/view → build reporter from settings → charge.
  - [ ] `test.php`/mock harness: hook fires a charge with resolved wallet/price.
  - [ ] Boot `wordpress` (+ db) in Docker; install + configure the plugin.
  - [ ] L3 real gated view → L4 author paid.
  - [ ] Recipe: `deploy/wordpress/README.md` + testing-plan row.
- **Blockers/notes:** PHP is new to this repo (added tooling). Highest single effort;
  schedule last.

---

## Cross-cutting work (shared by every new platform)

- **Resolver / moat:** start with a static `mapResolver`; graduate to a real registry
  when an id needs canonicalization (music already uses `createMusicBrainzResolver`).
  Unknown id → **meter-and-skip (return null), never mischarge.**
- **Rail wiring:** each L4 loop = deploy `StakeVaultFactory` on anvil, run
  `up-facilitator`, consumer stakes + grants via `@universal-paywall/agent`, adapter
  calls `reporter.report`, assert payee balance. Model on existing
  `scripts/e2e-*-live-docker.mjs`.
- **CI stays hermetic:** L1+L2 run on every push; L3+L4 are the per-platform
  acceptance gate (Docker + anvil), run on the platform branch.
- **No platform edits:** any installed artifact is a *published* plugin (PeerTube,
  WordPress) or the platform's own official add-on (Jellyfin webhook) — never a source
  change. The `mnemonik-dev/*` platform forks are reference-only.

## Suggested order (lowest risk → highest)

1. **Subsonic family** (boot + verify; ~no code)
2. **Funkwhale** (reuse; heavier image)
3. **Emby** (thin adapter)
4. **PhotoPrism** (proxy, model on Immich)
5. **Plex** (adapter cheap; L3 gated on Plex Pass)
6. **Nextcloud** (spike surface, then adapter)
7. **WordPress** (new PHP plugin package — last)

## Open decisions for you to mark

- [ ] Confirm the platform set (all 7 above, or a subset).
- [ ] Plex: acquire a Plex Pass token for a fully-live L3, or accept L1/L2 + L4-only?
- [ ] Nextcloud: prefer the webhook surface or the reverse-proxy surface?
- [ ] WordPress: in scope now, or defer (new PHP toolchain)?
