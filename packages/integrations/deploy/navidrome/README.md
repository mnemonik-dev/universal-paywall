# Navidrome — per-listen royalty (music)

**Attach surface (verified):** Navidrome's ListenBrainz scrobble target is
configurable — `consts/consts.go:82` defaults
`DefaultListenBrainzBaseURL = "https://api.listenbrainz.org/1/"`, overridable via
`ND_LISTENBRAINZ_BASEURL`. Point it at the sidecar and Navidrome scrobbles each
play to us natively, with **zero fork change** and no proxy.

## Route status: BUILT (gap #1 closed)

The sidecar now implements the two ListenBrainz endpoints Navidrome's client calls
(verified against `navidrome/adapters/listenbrainz/client.go`):

- `GET /1/validate-token` (`Authorization: Token <token>`) → `{ valid: true, user_name, code: 200 }`
  so the token links.
- `POST /1/submit-listens` → maps `payload[].track_metadata.additional_info.recording_mbid`
  (fallback first `artist_mbids`) → `resolveCreator`, and the `Token` → `resolvePayer`,
  then charges `RATE`. `playing_now` submissions are metered-and-skipped.

Run with `PLATFORM=navidrome RATE=<micro-USDC per listen>`. Set
`MUSICBRAINZ_USER_AGENT` to resolve `recording_mbid → artist_mbid → wallet` via
WS/2 (gap #4, built + live-validated) with `CREATOR_WALLETS` keyed on artist MBID;
see `../musicbrainz/README.md`.

## Steps

1. Start rail + facilitator + sidecar + Navidrome (`docker-compose.yml`).
2. Set `ND_LISTENBRAINZ_ENABLED=true` and
   `ND_LISTENBRAINZ_BASEURL=http://up-sidecar:8410/1/` in the Navidrome service.
3. In Navidrome, link ListenBrainz with the listener's token (the sidecar treats
   it as the payer key → `resolvePayer`; map it in `PAYER_WALLETS`).
4. Play a track → Navidrome scrobbles → sidecar charges `RATE` to the resolved
   artist → facilitator settles.

## Verify

**Real L3+L4 (PROVEN 2026-06-21):** `scripts/e2e-navidrome-live-docker.mjs` runs the
full loop against a live `ghcr.io/navidrome/navidrome` container — link a
ListenBrainz token, scrobble an MBID-tagged track, resolve `recording_mbid` ->
artist via live MusicBrainz WS/2, settle on anvil. The real Navidrome scrobble
payload matched the parser exactly (`listen_type:"single"`,
`recording_mbid`, `artist_mbids`); artist paid 100 micro-USDC. See the testing plan
(Navidrome row) for the exact container/env recipe.

Quick check: play a track (or `POST /1/submit-listens` directly) and confirm a
charge reaches the facilitator and settles on anvil.
</content>
