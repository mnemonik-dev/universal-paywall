# @universal-paywall/integrations

Permissionless **sidecar** integrations that attach the Universal Paywall
facilitator rail to the open-source creator stack. Each translates a platform's
existing event stream into a metered charge via `@universal-paywall/sdk`. No
upstream fork or PR required.

Prereq: the consumer (listener/viewer/crawler) has pre-staked and granted a policy
to the facilitator using `@universal-paywall/agent`.

## Shared primitive

```ts
import { createReporter, mapResolver } from '@universal-paywall/integrations';

const reporter = createReporter({
  facilitatorUrl: 'https://facilitator.example',
  apiKey: process.env.UP_API_KEY!,
  resolvePayer: mapResolver({ alice: '0xPayer…' }),   // userId → wallet (the registry/moat)
  resolveCreator: mapResolver({ 'track-1': '0xArtist…' }), // contentId → wallet
});
```

## Verticals

| Vertical | Import | Event → charge |
|---|---|---|
| Music (Subsonic/Navidrome) | `handleScrobble`, `parseSubsonicScrobble` | per scrobble → per-listen |
| Live video (Owncast) | `OwncastPresenceMeter` | `userJoined`/`userParted` → per-second |
| VOD (Jellyfin) | `handleJellyfinEvent` | `PlaybackStop` → per-minute |
| Feeds (RSSHub) | `handleCitation` | grounding citation → per-citation toll |

```ts
// Owncast example
const meter = new OwncastPresenceMeter(reporter, { ratePerSecond: 10n, streamerKey: 'streamer' });
// on each Owncast webhook event:
await meter.handle(event);
```

Each call returns a structured `ReportOutcome` (`charged` / `unresolved_payer` /
`unresolved_creator` / `zero_amount`) — unknown users/content are metered-and-
skipped, never thrown.

See `work/creator-platform-integrations/` for the full platform list, integration
patterns, and the PeerTube/Mastodon plugin-provider drafts.

**Adding a new platform?** Follow `INTEGRATION-PLAYBOOK.md` — a step-by-step
instruction doc with a discovery questions script, per-pattern build steps, the test
ladder (L1→L4), and a definition-of-done checklist.
