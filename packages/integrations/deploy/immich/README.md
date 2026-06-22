# Immich — per-resolve photo license (reverse-proxy)

**Attach surface (verified):** Immich serves shared-link assets at
`GET /api/assets/:id/{original,thumbnail,video/playback}?key=…|slug=…` and exposes
the asset's `ownerId` (+ `exifInfo`) at `GET /api/assets/:id?key=…`. The integration
is a **reverse proxy in front of Immich** — zero Immich edit; it attaches at the
HTTP boundary.

## How it works

`createImmichProxy({ upstreamUrl, reporter, licenseFee })` transparently proxies
every request to Immich and, on each **external shared-link asset resolve**, looks
up the asset owner (EXIF artist when present, else `ownerId`) and reports a
per-resolve license fee. Dedupes thumbnail+original of one view to a single charge;
the owner viewing their own asset (no share key) is not metered.

```bash
PLATFORM=immich-proxy UPSTREAM_URL=http://immich:2283 RATE=25000 \
  PAYER_WALLETS='{"<resolverId>":"0x..."}' CREATOR_WALLETS='{"<ownerId-or-artist>":"0x..."}' \
  FACILITATOR_URL=... FACILITATOR_API_KEY=... up-integration
```

The viewer/payer identity is an `x-resolver-id` header (an agent/downloader),
falling back to the share key. Point your share URLs / clients at the proxy instead
of Immich directly.

## Verify

**Real L3+L4 (PROVEN 2026-06-21):** `scripts/e2e-immich-live-docker.mjs` runs the
full loop against a live Immich (server + vectorchord postgres + redis): upload a
photo, create a shared link, resolve it through the proxy — the real image bytes
stream through (200) and the license fee settles on anvil (owner paid 25000). See
the testing plan (Immich row) for the container/setup recipe.

> The legacy event route (`POST /immich/resolve`, `PLATFORM=immich`) remains for
> callers that already extract the resolve event themselves; the reverse-proxy is
> the zero-config auto-attach.
