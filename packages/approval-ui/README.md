# @universal-paywall/approval-ui

Production browser approval page for the Universal Paywall **exact x402** rail.

When a payer receives a `402 Payment Required` response from a service that uses
Universal Paywall, the response includes an `approval_url`. Opening that URL in a
browser presents this page. The page:

1. Loads the quote for the operation from the approval server.
2. Detects the user's injected Ethereum wallet (e.g. MetaMask).
3. Signs an EIP-3009 `TransferWithAuthorization` typed-data message.
4. Submits the signed authorization back to the approval server for settlement.

The page is framework-agnostic vanilla TypeScript so it can be wrapped by
React/Vue/Svelte consumers or served directly by `mnemonic-mcp`.

## Build

```bash
npm install
npm run build
```

Built assets are written to `dist/`.

## Development

```bash
npm run dev
```

## Type check

```bash
npm run typecheck
```

## Server integration

`mnemonic-mcp` serves the built assets:

- `GET /approve?operation_id=...&quote_id=...` serves `dist/index.html`.
- `/assets/*` is served from `dist/assets/`.
- `GET /api/quote/{operation_id}` returns the operation quote.
- `GET /api/chains/{chain_id}` returns chain metadata for `wallet_addEthereumChain`.
- `POST /api/settle` proxies settlement to the facilitator.

Set `MNEMONIC_APPROVAL_UI_DIST` to the absolute path of `dist/` when starting
`mnemonic-mcp`.

## Security notes

- The facilitator API key is held by the server; it never reaches the browser.
- `/approve` is served with a strict Content-Security-Policy that only allows
  same-origin scripts and the configured chain RPC endpoint.
- Approval routes are rate-limited per IP.

## Wallet support

Current milestone: **injected MetaMask / EIP-1193 wallets only**.

WalletConnect support is tracked for a future milestone.
