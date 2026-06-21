# PeerTube — per-view (federated VOD)

**Attach surface (verified):** PeerTube exposes the server hook
`action:api.video.viewed` (`PeerTube/packages/models/src/plugins/server/server-hook.model.ts:186`).
There is **no native view webhook** — confirmed by inspecting the fork — so a
sidecar cannot observe views without a plugin. The plugin register API is grounded
in `PeerTube/packages/tests/fixtures/peertube-plugin-test/main.js`:
`register({ registerHook, registerSetting, settingsManager, getRouter })`.

## Integration shape: a separately PUBLISHED plugin (still not a fork edit)

Under the sidecars-only decision we do not modify the PeerTube fork. The operator
installs a **published** `peertube-plugin-universal-paywall` that registers the
view hook and reports each view to the rail. The enabling upstream change already
landed (`req.rawBody`, PeerTube PR #6300). Demand: the 7-year issue #1586.

> This is the one vertical whose artifact is a standalone npm package, not a route
> in `@universal-paywall/integrations`. We can build + test the plugin source here;
> the terminal **publish** step (npm / the PeerTube plugin index) is external.

## Plugin package layout (to build in the implementation phase)

```
peertube-plugin-universal-paywall/
  package.json        # name, engine.peertube, library: "./main.js", keywords [peertube, plugin]
  main.js             # register(): settings + view hook + reporter
  README.md
```

`main.js` (grounded against the fixture API and `@universal-paywall/integrations`'s
`createReporter` / `mapResolver`):

```js
async function register ({ registerHook, registerSetting, settingsManager }) {
  for (const [name, label] of [
    ['facilitator-url', 'Facilitator URL'],
    ['facilitator-api-key', 'Facilitator API key'],
    ['price-micro-usdc', 'Price per view (micro-USDC)'],
    ['viewer-wallets', 'Viewer wallet map (JSON)'],
    ['channel-wallets', 'Channel wallet map (JSON)'],
  ]) registerSetting({ name, label, type: 'input' })

  const { createReporter, mapResolver } = await import('@universal-paywall/integrations')
  const get = (k) => settingsManager.getSetting(k)

  registerHook({
    target: 'action:api.video.viewed',
    handler: async ({ video, req }) => {
      const reporter = createReporter({
        facilitatorUrl: await get('facilitator-url'),
        apiKey: await get('facilitator-api-key'),
        resolvePayer: mapResolver(JSON.parse((await get('viewer-wallets')) || '{}')),
        resolveCreator: mapResolver(JSON.parse((await get('channel-wallets')) || '{}')),
      })
      await reporter.report({
        payerKey: req?.headers?.['x-payer-user'] ?? 'anonymous',
        creatorKey: String(video.channelId),
        amount: BigInt((await get('price-micro-usdc')) || '1000'),
        ref: `peertube:${video.uuid}:${Date.now()}`,
      })
    },
  })
}
module.exports = { register, unregister: () => Promise.resolve() }
```

## Open design questions (resolve during implementation)

1. **Payer identity.** `action:api.video.viewed` is fired for anonymous views; the
   hook's `req` may not carry a logged-in user. Options: (a) a viewer browser
   extension (see `../browser-extension/`) stamps `x-payer-user`; (b) bill only
   authenticated views via `res.locals.oauth?.token?.User`. Pick per deployment.
2. **Dedupe.** PeerTube already debounces view counts; confirm the hook fires once
   per counted view so we don't double-charge. The `ref` is per-view for idempotency.
3. **Bundling.** PeerTube loads the plugin in its server runtime; vendor
   `@universal-paywall/integrations` (zero-dep beyond `@universal-paywall/sdk`) into
   the plugin bundle.

## Steps

1. Scaffold + build `peertube-plugin-universal-paywall` (above). Publish to npm /
   the PeerTube plugin index (external step).
2. Operator: Admin -> Plugins -> install it, set facilitator URL + key, price,
   and the viewer/channel wallet maps.
3. View a video -> hook -> facilitator charge -> settle.

## Verify (local)

`docker run peertube`, install the local plugin build (Admin -> Plugins -> install
from disk), view a video, confirm a charge reaches the facilitator and settles on
anvil. See `../../../../work/creator-platform-integrations/testing-plan.md` (PeerTube row).

> No `docker-compose.yml` here yet: the recipe is gated on the plugin package
> existing (built in the implementation phase).
</content>
