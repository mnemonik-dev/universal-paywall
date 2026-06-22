---
feature: creator-platform-integrations
doc: testing-plan
created: 2026-06-21
question: "how do we know Universal Paywall actually works with each platform?"
---

# Testing Plan — Per-Integration Verification

How we prove each integration end-to-end. Four layers per platform; an integration
is "done" only when its layer-4 money loop settles on-chain.

## The four test layers

| Layer | What it proves | Tools | Where |
|---|---|---|---|
| **L1 Unit** | the adapter maps a platform event -> the right `charge` args | vitest | `packages/integrations/src/__tests__` |
| **L2 Sidecar-contract** | the running sidecar answers real platform-shaped HTTP correctly (status, body, headers) | node `fetch` against `createSidecarServer` | per-platform smoke script |
| **L3 Real-instance** | a real platform instance, wired per its recipe, actually calls our sidecar on a real event | Docker compose (`deploy/<platform>/`) | local / CI-with-services |
| **L4 Anvil money loop** | the full chain: stake+grant -> event -> charge -> facilitator batch -> `settle` -> **payee balance increases** | anvil + `e2e:anvil` | `scripts/e2e-integration-anvil.ts` |

L1+L2 run in CI on every push (fast, hermetic). L3+L4 are the acceptance gates per
platform (heavier; run on the platform branch).

## The one universal assertion

For every platform the success check is the same:

> After the platform emits one consumption event from a staked consumer, the
> resolved **payee's on-chain USDC balance increased by exactly the expected
> amount** (rate x units), in one batched `StakeVault.settle`.

Everything else (HTTP shapes, webhook registration) is plumbing that exists to make
that one assertion true.

## Shared L4 harness (already proven for Owncast)

```bash
export PATH="/tmp/foundry:$PATH"
anvil --chain-id 31337 --port 8545 --silent &        # local chain
# deploy StakeVaultFactory; start up-facilitator; (per HANDOFF bootstrap)
# consumer: @universal-paywall/agent -> ensureVault + deposit + grant(facilitator, cap, validUntil)
# run the platform event; assert payee balance delta; pkill -x anvil
npm run e2e:anvil -w @universal-paywall/integrations   # Owncast loop today; extend per platform
```

Each new platform adds a variant of `e2e-integration-anvil.ts` that injects that
platform's event shape, then reuses the same stake/grant/settle/assert spine.

## Per-platform test matrix

| Platform | Trigger (L3) | Sidecar observation | Expected charge | L2 contract check | L4 status |
|---|---|---|---|---|---|
| **Owncast** | viewer joins+parts chat | `POST /owncast` USER_JOINED/PARTED | `(parted-joined) x ratePerSecond` | webhook body -> `charged` | **L3+L4 PASS** (real instance; `e2e:owncast` + live-docker harness) |
| **Navidrome** | play a track (or hit scrobble) | `POST /1/submit-listens` (+ `GET /1/validate-token`) | `ratePerListen` per `single` listen | token links; `playing_now` skipped; mbid->creator | **L3+L4 PASS** (real instance + live MusicBrainz) |
| **Jellyfin** | play+stop via official webhook plugin | `POST /jellyfin` PlaybackStop | `floor(minutes) x ratePerMinute` | PlaybackStop bills, Progress doesn't | **L3+L4 PASS** (real instance + official plugin) |
| **RSSHub** | crawler cites a fetched item | `POST /citation` | `toll` per citation | author -> creator | **L3+L4 PASS** (live RSSHub item) |
| **Mastodon** | instance fetches campaigns | `GET /api/v1/donation_campaigns` | n/a (provider); donations settle at `donation_url` | 200 echoes `locale`; 204 when unset | **L2 + donation L4 PASS** (`e2e:mastodon`) |
| **PeerTube** | view a video (plugin) | plugin `action:api.video.viewed` -> reporter | `pricePerView` | plugin hook fires once/view | **L3+L4 PASS** (real PeerTube 7.3.0 + real headless-browser player -> counted view -> settle) |
| **MusicBrainz** | resolve `recording_mbid` | resolver call inside `resolveCreator` | n/a (registry); enables Navidrome payout | mbid->artist->wallet; unknown->null | **PASS** (8 unit + live WS/2) |
| **Subsonic** (gonic family) | scrobble a track | `createSubsonicProxy` in front of the server | `ratePerPlay` per submission | proxied + metered | **L3+L4 PASS** (live gonic) |
| **Browser extension** | browse to an x402 resource | `agent.fetchWithPaywall` 402 -> grant -> retry | grant `cap`-bounded | `onMessageExternal` returns paid 200 | **node E2E + BROWSER E2E PASS**: bundled MV3 loaded in headless Chromium, in-SW agent auto-pays -> on-chain settle |

## L2 contract checks (write one per platform)

A node script that boots the sidecar via `createSidecarServer` and asserts the
exact bytes a real platform sends/expects. Pattern (already done live for Mastodon:
200 with echoed `locale`, 204 empty):

```js
const srv = createSidecarServer([routeUnderTest]);
srv.listen(PORT);
const res = await fetch(url, { method, headers, body });
assert(res.status === expected && (await res.json()) matches shape);
```

Promote the stable ones into vitest using `node:http` + an ephemeral port so they
run in CI without Docker.

## Platform-specific notes

- **Navidrome:** point `ND_LISTENBRAINZ_BASEURL` at the sidecar; link with a token
  that's in `PAYER_WALLETS`. Assert the scrobble (not now-playing) triggers exactly
  one charge to the `recording_mbid`'s artist.
- **Jellyfin:** the official webhook plugin must template `NotificationType`,
  `UserId`, `ItemId`, `PlaybackPositionTicks`; assert we bill on Stop only and round
  down whole minutes (no double-count from Progress events).
- **Mastodon:** no money loop in the provider itself — its L4 is the **donation
  flow at `donation_url`**, which reuses the agent+facilitator L4 loop. Test the
  provider at L2; test the donation settlement via the agent e2e.
- **MusicBrainz:** run the **local fork** for L3/L4 to avoid the public WS/2
  ~1 req/s limiter and egress limits; assert the recording->artist cache prevents
  repeat lookups.
- **Browser extension:** L3 = load unpacked MV3 against a resource gated by
  `@universal-paywall/resource-adapter`; assert auto-pay yields 200 and a second
  extension gets a paid response via `onMessageExternal`. Gated on the agent signer
  abstraction.

## CI vs. acceptance

- **CI (every push):** L1 (vitest) + L2 (in-process HTTP). Hermetic, no Docker, no
  chain. Keeps egress at zero.
- **Acceptance (per-platform branch, before marking a gap done):** L3 against the
  Docker'd platform + L4 anvil money loop. This is the gate that flips a row to
  PASS.

## Definition of "tested" per platform

1. L1 adapter unit test green.
2. L2 contract check green (real platform request/response bytes).
3. L3 a real instance calls the sidecar on a real event.
4. L4 the payee's on-chain balance increased by the expected amount.

## Owncast acceptance — done (2026-06-21)

`scripts/e2e-owncast-acceptance-anvil.ts` (`npm run e2e:owncast`) runs the **real
sidecar HTTP server** (`createSidecarServer` + `owncastRoute`) and POSTs the
**byte-exact Owncast webhook JSON** (full `eventData` envelope: `status`,
`serverURL`, `id`, `timestamp`, `user.id`), through the facilitator to an on-chain
settle. **PASS** — streamer paid `60s x rate`.

- **Bug found + fixed by running L4 over real HTTP:** charge outcomes carry
  `amount: bigint`, which `JSON.stringify` cannot serialize — every charge response
  was 400ing over the wire. The in-process e2e and unit tests never serialized, so
  they missed it. Fixed with a bigint-safe serializer in `serve.ts` (`toJson`,
  amounts -> decimal strings); added an HTTP regression test. This bug affected
  **all** charge-returning routes (owncast/subsonic/jellyfin/rsshub/immich), so the
  fix unblocks every platform's real-HTTP path, not just Owncast.
## Owncast REAL L3 — done (2026-06-21)

Docker **does** work in this environment — the daemon just isn't started by
default. Start it as root (`nohup dockerd >/tmp/dockerd.log 2>&1 &`) and image
pulls (Docker Hub) succeed. Full real L3 ran green via
`scripts/e2e-owncast-live-docker.mjs`:

1. `docker run -d --network host owncast/owncast:latest` (host net so it reaches the
   host sidecar + anvil).
2. ffmpeg RTMP push (`rtmp://localhost:1935/live/abc123`) brings the stream online —
   required, since Owncast only fires the USER_JOINED webhook while online
   (`services/chat/server.go:180`).
3. Register a real chat user (`POST /api/chat/register`), register our webhook
   (`POST /api/admin/webhooks/create`, Basic admin/abc123), connect a real chat
   websocket -> real USER_JOINED; disconnect -> USER_PARTED after the 10s prune.
4. **Real webhook bytes matched the sidecar shape exactly** (`type`,
   `eventData.user.id`, `eventData.timestamp` RFC3339); 14s presence -> charge
   **14000** -> facilitator settle -> **streamer paid 14000 micro-USDC on-chain.**

This is the genuine L3: a live Owncast process emitting real webhooks settled
through the rail. The acceptance script (`e2e:owncast`) remains the fast,
Docker-free CI proxy using the same (now field-verified) bytes.

## Navidrome REAL L3 — done (2026-06-21)

Full vertical incl. the moat, via `scripts/e2e-navidrome-live-docker.mjs` against a
live `ghcr.io/navidrome/navidrome` container (GHCR avoids Docker Hub's anon pull
limit). Navidrome scrobbles natively to our ListenBrainz target — **zero Navidrome
changes**:

1. Tagged track (ffmpeg, `MUSICBRAINZ_TRACKID=f1aa509e...`) scanned; admin
   auto-created (`ND_DEVAUTOCREATEADMINPASSWORD`); `ND_LISTENBRAINZ_BASEURL` ->
   `http://localhost:8410/1/` (host network).
2. Link a ListenBrainz token via the native API (`PUT /api/listenbrainz/link?jwt=`)
   -> hits our `GET /1/validate-token` (returns valid). The token is the payer key.
3. Subsonic `scrobble.view?...&submission=true` -> Navidrome forwards to the
   ListenBrainz target -> our `POST /1/submit-listens`.
4. **Real Navidrome payload matched the parser exactly:** `listen_type:"single"`,
   `recording_mbid:"f1aa509e-..."`, `artist_mbids:["4d5447d7-..."]`.
5. recording_mbid -> **live MusicBrainz WS/2 resolver** -> John Lennon -> wallet ->
   charge 100 -> facilitator -> **artist paid 100 micro-USDC on-chain.** PASS.

So both gap #1 (ListenBrainz target) and gap #4 (MusicBrainz resolver) are now
field-verified together against a real instance + the real MusicBrainz API.

## Jellyfin REAL L3 — done (2026-06-21)

Via `scripts/e2e-jellyfin-live-docker.mjs` against a live
`ghcr.io/jellyfin/jellyfin:latest` (10.11.11) + the **official Webhook plugin**
(21.0.0.0). No fork change — the plugin delivers playback events.

1. Startup wizard (admin/abc123), Movie library, 2-min test movie scanned.
2. Webhook plugin installed (catalog was empty on a fresh server -> dropped the
   release zip into `/config/plugins/Webhook` + restart) and configured via
   `POST /Plugins/{guid}/Configuration`: Generic destination -> our `/jellyfin`,
   `NotificationTypes:["PlaybackStop"]`, `SendAllProperties:true`, EnableMovies.
3. Reported a real playback start + stop (`POST /Sessions/Playing[/Stopped]`,
   `PositionTicks=1_200_000_000`) -> `ISessionManager.PlaybackStopped` -> plugin POST.
4. **The plugin's real payload matched the route exactly:** `NotificationType:
   "PlaybackStop"`, `UserId`, `ItemId`, `PlaybackPositionTicks:1200000000` (plus
   lots of extra fields we ignore). Billed 2 min x 1000 -> **creator paid 2000
   micro-USDC on-chain.** PASS.

Note: `SendAllProperties:true` makes the plugin emit those exact PascalCase keys, so
no Handlebars template is needed.

## Immich real L3 — done (2026-06-21)

Via `scripts/e2e-immich-live-docker.mjs` against a live Immich (server +
vectorchord postgres + redis): `createImmichProxy` sits in front of Immich; an
external viewer resolves a real shared-link asset THROUGH the proxy:

1. Admin signup -> upload a photo -> create an INDIVIDUAL shared link (real key).
2. `GET <proxy>/api/assets/<id>/original?key=<key>` -> proxy streams the real image
   bytes from Immich (200, 4279 bytes) AND meters the resolve: it looks up the
   asset owner via `GET /api/assets/<id>?key=<key>` (EXIF artist when present, else
   `ownerId`) and reports a license fee.
3. fee -> facilitator -> on-chain settle -> **owner paid 25000 micro-USDC.** PASS.

No Immich fork was needed (none is in scope) - the L3 ran the upstream
`ghcr.io/immich-app/immich-server` image, same as every other platform's L3.
Note: Immich's `exifInfo` did not expose an `artist` field for the test photo, so
the proxy correctly fell back to `ownerId` (the documented behavior).

## PeerTube real-instance verification — done (2026-06-21)

Against a live **PeerTube 7.3.0** stack (postgres + redis, host net, transcoding
off): a **self-contained esbuild bundle** of `peertube-plugin-universal-paywall`
(integrations + sdk inlined, so no unpublished-dep install failure) was installed
via the plugin CLI and **registered the `action:api.video.viewed` hook + settings,
enabled** (confirmed in logs and `/api/v1/plugins`), and configured via
`PUT /api/v1/plugins/.../settings` (facilitator URL + wallet maps + price).

Not reached: a PeerTube **counted** view. The hook fires only when
`VideoStatsManager.processLocalView` returns `successView`, which needs the
watch-time threshold (`count_view_after`, default 10s) met via accumulated
viewer-stats — driven by a real player sending periodic progress over time, not by
scripted view POSTs (verified: instrumented the hook; it did not fire from the
API). The per-view hook->charge->settle behavior itself is covered by the unit test
(`test.mjs`, 9 assertions incl. a real HTTP charge). A browser-driven view session
would close this last step.
</content>
