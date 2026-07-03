# @universal-paywall/extension

The **payer-side** adaptor: a WebExtension (MV3) that auto-pays x402 paywalls on
the user's behalf via `@universal-paywall/agent`, and lets **any other extension or
page** request a paid fetch — without reimplementing the rail. It complements the
creator-side sidecars (it pays the paywalls they meter).

## Modes

1. **Library** — an extension bundles this; its background hosts a `PayerAgent`.
2. **Host/bridge** — one installed Universal Paywall extension exposes
   `onMessageExternal`; other extensions send `{ type: 'up:fetch', url, init }` and
   get a paid `Response` back (shared wallet, one grant).
3. **Page bridge** — `content.js` injects `window.universalPaywall.upFetch(url)`.

## Layout

| File | Role |
|---|---|
| `src/handler.js` | **core** message router over a `PayerAgent` (`up:status` / `up:ensureGrant` / `up:fetch`) — runtime-independent, unit-tested |
| `src/bridge.js` | typed client (`upFetch`, `status`, `ensureGrant`) over an injected `send` |
| `src/messages.js` | the message contract both ends share |
| `src/background.js` | MV3 service worker: builds the agent, wires `onMessage` + `onMessageExternal` |
| `src/content.js` | injects `window.universalPaywall` (page bridge) |
| `src/config.js` | config (`chrome.storage`) + **signer construction** |
| `manifest.json` | MV3 manifest |

## The signer (no raw keys)

Built on the agent's **account/transport injection** (added with this package):
`createPayerAgent({ account, walletTransport, … })` instead of a raw `payerKey`.
Two supported models, wired in `config.js#buildAccount`:

1. **Browser wallet (preferred):** an EIP-1193 account + `custom(provider)`
   transport — every write is wallet-approved.
2. **Managed session account:** a cap-bounded key the extension generates/stores;
   the on-chain grant `cap` bounds the spend. Still never shipped in code.

`buildAccount` throws until configured, so the extension can't run without a signer.

## Security

- **Spend caps** on-chain (the `StakeVault` grant `cap`) + per-origin/day locally.
- **Allowlist** (`allowList`) gates `onMessageExternal` / page callers.
- Pages get only the read + paid-fetch surface (no grant management).

## Test

```bash
npm test           # node test.mjs — handler routing + bridge (13 assertions)
npm run build      # node build.mjs — esbuild self-contained MV3 bundle into dist/
npm run e2e:anvil  # node e2e-anvil.mjs — full payer loop on anvil (node; needs anvil :8545)
npm run e2e:browser # node e2e-browser.mjs — REAL MV3 runtime in headless Chromium (Playwright)
```

Unit (`test.mjs`): `up:status`/`up:ensureGrant`/`up:fetch` routing, response
serialization, bad/unknown messages, the external-sender allowlist, agent-error
handling, and the bridge returning a real `Response`.

E2E (`e2e-anvil.mjs`): the headless equivalent of the extension auto-paying a
paywall — a real `PayerAgent` built from an **injected account** (the signer
abstraction), driven through the handler + bridge against a real x402 resource
(`@universal-paywall/resource-adapter`): `bridge.upFetch` -> `up:fetch` ->
`fetchWithPaywall` -> 402 -> auto vault/deposit/grant -> 200 served -> facilitator
settles -> **creator paid on-chain**. PASS.

Browser E2E (`e2e-browser.mjs`): loads the **bundled extension as an unpacked MV3
add-on in real headless Chromium** (Playwright). The in-browser service worker
builds the agent (bundled viem) from a **managed session account** and auto-pays
the x402 resource on-chain. Proves the shipped bundle runs in a browser — viem +
agent + on-chain signing + fetch all work in the SW sandbox. PASS.
