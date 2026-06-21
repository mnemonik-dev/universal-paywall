# Navidrome — per-listen royalty (music)

**Attach surface (verified):** Navidrome's ListenBrainz scrobble target is
configurable — `consts/consts.go:82` defaults
`DefaultListenBrainzBaseURL = "https://api.listenbrainz.org/1/"`, overridable via
`ND_LISTENBRAINZ_BASEURL`. Point it at the sidecar and Navidrome scrobbles each
play to us natively, with **zero fork change** and no proxy.

## Gap to close first (route not built yet)

The current sidecar speaks Subsonic `scrobble.view` (GET). For the ListenBrainz
attach it must expose a ListenBrainz-compatible endpoint:

- `POST /1/submit-listens` accepting the ListenBrainz JSON payload, mapping
  `payload[].track_metadata.additional_info.recording_mbid` (or
  `artist_mbid`) → `resolveCreator`, and `userId` (auth token / header) →
  `resolvePayer`, then `reporter.report({ amount: RATE })`.
- Add `case 'navidrome'` to the CLI selecting this route.

Track this in `work/creator-platform-integrations/deployment-plan.md` (gap #1).
The MusicBrainz recipe supplies the `recording_mbid → artist → wallet` registry.

## Steps (after the route exists)

1. Start rail + facilitator + sidecar + Navidrome (`docker-compose.yml`).
2. Set `ND_LISTENBRAINZ_ENABLED=true` and
   `ND_LISTENBRAINZ_BASEURL=http://up-sidecar:8410/1/` in the Navidrome service.
3. In Navidrome, link ListenBrainz with any non-empty token (the sidecar treats it
   as the payer key → `resolvePayer`).
4. Play a track → Navidrome scrobbles → sidecar charges `RATE` to the resolved
   artist → facilitator settles.

## Verify

Play a track (or `POST /1/submit-listens` directly), confirm a charge reaches the
facilitator and settles on anvil.
</content>
