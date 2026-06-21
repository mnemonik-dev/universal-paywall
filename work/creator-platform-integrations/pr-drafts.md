---
feature: creator-platform-integrations
doc: pr-drafts
created: 2026-06-17
---

# Upstream PR / Plugin Drafts

For the two verticals where the integration path is a **published plugin / external
provider** (not a sidecar), this documents the PR-ready artifact and the exact
upstream path. **Nothing here is auto-submitted** — see "Why no auto-PR" in
`README.md` (permissionless-by-design, upstreams reject per-user payment plumbing,
and this environment's GitHub is scoped to `mnemonik-dev/universal-paywall`).

## 5. PeerTube — published plugin (`peertube-plugin-universal-paywall`)

**Path:** PeerTube integrates via its **plugin loader**, not a core PR. The
enabling upstream change already landed
([PR #6300](https://github.com/Chocobozzz/PeerTube/pull/6300), `req.rawBody` for
Stripe-style webhooks). You publish a plugin to npm/the PeerTube marketplace; the
operator installs it. Demand is documented in the 7-year
[#1586](https://github.com/Chocobozzz/PeerTube/issues/1586) thread.

**Draft `main.js` (server plugin):**

```js
// peertube-plugin-universal-paywall — registers a view hook → facilitator charge
async function register({ registerHook, getRouter, settingsManager }) {
  const { createReporter, mapResolver } = await import('@universal-paywall/integrations');
  const reporter = createReporter({
    facilitatorUrl: await settingsManager.getSetting('facilitator-url'),
    apiKey: await settingsManager.getSetting('facilitator-api-key'),
    resolvePayer: mapResolver(JSON.parse(await settingsManager.getSetting('viewer-wallets') || '{}')),
    resolveCreator: mapResolver(JSON.parse(await settingsManager.getSetting('channel-wallets') || '{}')),
  });

  registerHook({
    target: 'action:api.video.viewed',
    handler: async ({ video, req }) => {
      await reporter.report({
        payerKey: req.headers['x-payer-user'] ?? 'anonymous',
        creatorKey: String(video.channelId),
        amount: BigInt(await settingsManager.getSetting('price-micro-usdc') || '1000'),
        ref: `peertube:${video.uuid}:${Date.now()}`,
      });
    },
  });
}
module.exports = { register, unregister: () => Promise.resolve() };
```

**To ship:** scaffold with `peertube-plugin-quickstart`, depend on
`@universal-paywall/integrations`, publish as `peertube-plugin-universal-paywall`.
No fork or core PR.

## 6. Mastodon — external campaign-source provider

**Path:** Mastodon's [`#37880`](https://github.com/mastodon/mastodon/pull/37880)
added a server-side `GET /api/v1/donation_campaigns` slot that fetches + caches an
**external** campaign source. You run that source; the instance operator points at
it. No core PR — you fill a sanctioned slot. (The companion banner UI
[#36102](https://github.com/mastodon/mastodon/pull/36102) is the only open
core-side surface, and is end-user UI — out of scope.)

**Draft provider endpoint (returns the campaign JSON Mastodon caches):**

```ts
import { createServer } from 'node:http';
// Serves the donation-campaign payload; "donations" settle through our rail via
// the agent + facilitator (onchain-transparent), per-instance configurable.
createServer((req, res) => {
  if (req.url === '/api/v1/donation_campaigns') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'up-1',
      banner_message: 'Support this instance — settles onchain via Universal Paywall',
      donation_url: 'https://pay.example/stake?facilitator=0x...&factory=0x...',
      amounts: ['1000000', '5000000', '10000000'], // micro-USDC presets
    }));
    return;
  }
  res.writeHead(404).end();
}).listen(8500);
```

**To ship:** deploy the provider, document the instance setting that points
Mastodon's donation-campaigns fetch at it. Per-user creator payments (the
`attributedTo` reshare-settlement play) remain a separate permissionless
federation-peer sidecar — a later vertical.

## Sidecar verticals (1–4, 7): no PR artifact

Implemented as runnable code in `packages/integrations/` (music/live/VOD/feeds) and
described for photo (Immich shared-link wrapper). These attach via existing public
APIs — there is no upstream artifact to submit.
