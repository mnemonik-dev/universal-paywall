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

## Publish

`npm publish` as `peertube-plugin-universal-paywall` (and/or submit to the PeerTube
plugin index). Depends on `@universal-paywall/integrations`. Publishing is the only
step that can't be done from the integration repo's CI.

> Real-instance L3 (PeerTube + Postgres + Redis): install this plugin, upload a
> video, view it, and confirm the charge settles. See
> `work/creator-platform-integrations/testing-plan.md` (PeerTube row).
