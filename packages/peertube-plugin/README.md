# peertube-plugin-universal-paywall

Per-view onchain settlement for [PeerTube](https://joinpeertube.org) via the
Universal Paywall rail. Registers the `action:api.video.viewed` server hook and
reports each view as a metered charge to the facilitator — no PeerTube core fork
(PeerTube has no native view webhook, so a published plugin is the attachment
point; the enabling `req.rawBody` change landed in PeerTube PR #6300).

## Install (operator)

1. Admin → Plugins → search/install `universal-paywall` (or install from disk for a
   local build).
2. Configure settings:
   - **Facilitator URL** / **Facilitator API key** — the Universal Paywall facilitator.
   - **Price per view (micro-USDC)** — e.g. `1000`.
   - **Viewer wallet map** — JSON `{ "<payerKey>": "0x…" }` (the registry/moat).
   - **Channel wallet map** — JSON `{ "<channelId>": "0x…" }`.

On each view, the plugin resolves the payer (from an `x-payer-user` header stamped
by a viewer client / the browser-extension adaptor; anonymous views are
metered-and-skipped) and the channel wallet, then charges `price` to the rail.

## Develop / test

```bash
npm test    # node test.mjs — drives register() + the view hook against a mock facilitator
```

The core logic is in `main.js` (`register({ registerHook, registerSetting,
settingsManager })`). `test.mjs` proves: settings registered, the view hook fires a
charge with the resolved viewer/channel wallets and configured price, and
unknown-payer / unconfigured cases make no charge.

## Build (self-contained) + publish

`@universal-paywall/integrations` is a workspace package (not on npm), so a raw
`yarn install` of this plugin would fail. `npm run build` (esbuild) bundles it +
its deps into a single self-contained `dist/main.js`, so the published plugin has
**no external runtime dependency**. To publish: build, point `library` at
`dist/main.js` (and drop the dependency), then `npm publish` /submit to the
PeerTube plugin index. Publishing is the only step that can't be done from CI.

## Verified on a real PeerTube (2026-06-21)

The self-contained bundle was installed into a live **PeerTube 7.3.0** (postgres +
redis): the plugin **installs, registers the `action:api.video.viewed` hook + its
settings, and is enabled** (confirmed via logs + the `/api/v1/plugins` API), and is
configurable through `PUT /api/v1/plugins/.../settings`. Note: the hook fires only
on a PeerTube *counted* view (its anti-fraud watch-time threshold + viewer-stats
processing), which a real player session drives; the per-view charge behavior
itself is proven by `test.mjs`. See the testing plan (PeerTube row).
