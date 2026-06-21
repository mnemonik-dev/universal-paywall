# Browser-extension adaptor (payer-side)

The first **consumer-side** integration. Every other recipe attaches a *creator*
platform (the payee) to the rail; this one lets **any browser extension** become a
*payer* — auto-paying x402 paywalls and tipping creators on the user's behalf —
without reimplementing the rail. It complements the creator sidecars: extension
pays -> facilitator -> creator sidecar's payee gets settled.

## What it wraps

`@universal-paywall/agent` already does payer auto-pay in any fetch context:

```ts
createPayerAgent({ rpcUrl, chainId, payerKey, stakeVaultFactory, usdc, fetchImpl? })
  .fetchWithPaywall(url, init)   // sends a signed proof; on 402, grants on-chain + retries once
```

viem is isomorphic, so the agent runs inside a WebExtension MV3 service worker. The
adaptor packages it for the extension runtime and exposes it to other code.

## Integration modes

1. **Library mode** — an extension bundles `@universal-paywall/extension`; its own
   background service worker hosts a `PayerAgent` and calls `fetchWithPaywall` for
   the user's requests.
2. **Host/bridge mode** — one installed "Universal Paywall" extension exposes
   `chrome.runtime.onMessageExternal`; **any other extension** sends it a
   `{ type: 'up:fetch', url, init }` message and gets a paid response back. One
   wallet, one grant, shared across extensions.
3. **Page bridge** — a content script injects `window.universalPaywall` (a
   `postMessage` relay) so in-page JS can request a paid fetch.

## Proposed package: `@universal-paywall/extension`

```
packages/extension/
  src/
    background.ts   # hosts PayerAgent; runtime.onMessage + onMessageExternal handlers
    content.ts      # injects window.universalPaywall; relays to background
    bridge.ts       # typed client: upFetch(url, init), ensureGrant(), connectWallet()
    config.ts       # facilitator/factory/usdc/chain + spend caps (chrome.storage)
  manifest.json     # MV3: background.service_worker, optional declarativeNetRequest
```

Messaging API (typed in `bridge.ts`):

| Message | Action |
|---|---|
| `up:fetch { url, init }` | `agent.fetchWithPaywall` -> serialized `Response` |
| `up:ensureGrant { cap, validUntil }` | establish/refresh the facilitator grant |
| `up:status` | vault address, balance, current grant, spend-so-far |

## Status: BUILT (gap #5)

Implemented in `packages/extension/` (`@universal-paywall/extension`, MV3). The
prerequisite is done: `@universal-paywall/agent` now accepts an injected
`account` (+ optional `walletTransport`) instead of only a raw `payerKey`, so the
extension signs via a browser wallet (EIP-1193) or a managed cap-bounded session
account — never a raw key in code. Tested core handler + bridge (`node test.mjs`,
13 assertions). Only store-publishing is external.

> The prerequisite (agent account/transport injection) also benefits server
> deployments using a KMS/remote signer.

## Security model (decide during implementation)

- **Spend caps** enforced both on-chain (the `StakeVault` grant `cap`) and locally
  (per-origin/day budget in `chrome.storage`).
- **Origin allowlist** for `onMessageExternal` / page bridge — only approved
  extensions/origins may request payments.
- **User confirmation** UX for first payment to a new origin; silent within cap
  after that.

## Steps (implementation phase)

1. Add the signer abstraction to `@universal-paywall/agent` (prerequisite).
2. Scaffold `@universal-paywall/extension` (MV3) with the three modes.
3. Ship a reference extension + a demo "other extension" that calls it via
   `onMessageExternal`.

## Verify

**E2E (PROVEN, Docker-free):** `npm run e2e:anvil -w @universal-paywall/extension`
(anvil on :8545) drives the real payer loop through the extension handler + bridge
with an injected-account agent against a real x402 resource
(`@universal-paywall/resource-adapter`): `bridge.upFetch` -> `fetchWithPaywall` ->
402 -> auto vault/deposit/grant -> 200 -> facilitator settle -> creator paid 50000
on-chain. This is the headless equivalent of the extension auto-paying.

Full browser run: load the unpacked extension, browse to an x402-gated resource,
confirm auto-pay; confirm a second extension gets a paid response via
`onMessageExternal`. See the testing plan (browser-extension row).
</content>
