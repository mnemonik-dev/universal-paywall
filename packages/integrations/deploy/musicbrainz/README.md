# MusicBrainz — the registry / moat (resolver enrichment)

Not a payable vertical on its own. MusicBrainz is the **identity registry** that
turns a music scrobble into a payable creator: it maps a `recording_mbid` (carried
in ListenBrainz scrobbles, see the Navidrome recipe) to an artist (`artist_mbid` /
artist credit). The remaining `artist → wallet` half is the proprietary registry —
the moat.

## Attach surface (read-only, no fork change)

`musicbrainz-server` exposes WS/2: `GET /ws/2/recording/<mbid>?inc=artists&fmt=json`
returns the artist credits for a recording. The fork can be run locally or the
public `https://musicbrainz.org/ws/2/` used (rate-limited).

## Gap to close (resolver, not built yet)

Replace `mapResolver(staticMap)` for music with a `resolveCreator` that:

1. Takes a `recording_mbid` (or `artist_mbid`) from the scrobble.
2. Resolves it to a canonical `artist_mbid` via WS/2 (cache aggressively).
3. Looks up `artist_mbid → wallet` in the Universal Paywall registry.

Track as gap #4 in `deployment-plan.md`. This resolver is shared by the Navidrome
recipe and any other MusicBrainz-keyed music source.

## Verify

Given a known `recording_mbid`, the resolver returns a stable `artist_mbid` and (if
registered) a wallet; an unknown MBID returns `null` → the sidecar meters-and-skips.
</content>
