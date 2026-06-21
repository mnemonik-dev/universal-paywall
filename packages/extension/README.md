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
npm test    # node test.mjs — handler routing + bridge (13 assertions)
```

Covers: `up:status`/`up:ensureGrant`/`up:fetch` routing, response serialization,
bad/unknown messages, the external-sender allowlist, agent-error handling, and the
bridge returning a real `Response`.
