---
feature: x402-agent-payment
created: 2026-06-16
status: draft
---

# Code Research: x402-agent-payment

## Repo state (current)

```
universal-paywall/
  .claude/                 # global skills/methodology setup
  .gitignore
  CLAUDE.md                # top-level project instructions (REQUIRES UPDATE: still says Base)
  work/x402-agent-payment/ # this feature
```

No `packages/`, `apps/`, `contracts/` directories exist yet. **All implementation is greenfield.** No prior code to integrate with, refactor, or reuse. Project structure declared in `architecture.md` is target, not actual.

## External references (verified 2026-06-16)

### x402 protocol — official sources

- Spec: `https://github.com/coinbase/x402` (specs/schemes/exact/scheme_exact_evm.md)
- Network support (CDP facilitator): `https://docs.cdp.coinbase.com/x402/network-support`
- Verified wire format details:
  - 402 body: `{ x402Version: 1, accepts: [PaymentRequirements], error?: string }` (content-type `application/json`)
  - `PaymentRequirements`: `{ scheme: "exact", network, maxAmountRequired, resource, description, mimeType, payTo, maxTimeoutSeconds, asset, outputSchema?, extra }`
  - For EIP-3009 exact: `extra: { assetTransferMethod: "eip3009", name, version }`
  - `X-PAYMENT` header: `base64(JSON({ x402Version: 1, scheme, network, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } }))`
  - `X-PAYMENT-RESPONSE` header: `base64(JSON({ success, transaction, network, payer }))`
  - Network ID: canonical CAIP-2 strings — e.g. `eip155:8453` (Base), `eip155:84532` (Base Sepolia). x402 community also accepts named aliases (`base`, `base-sepolia`). For Arc: no canonical CAIP-2 string published; we use `arc-testnet` consistently.
- Settlement model: **facilitator pattern**. Client signs EIP-3009 authorization off-chain (no gas). Server (facilitator) calls `transferWithAuthorization` on token contract on client's behalf and pays gas. The facilitator can be CDP (Coinbase-hosted) or self-hosted.
- **CDP facilitator does NOT support Arc.** Supported: Base, Base Sepolia, Polygon, Arbitrum, World, World Sepolia, Solana Mainnet, Solana Devnet. For Arc we self-host.

### Arc Network (Circle Arc) — verified

- Sources: `developers.circle.com/stablecoins/usdc-contract-addresses`, `https://thirdweb.com/arc-testnet`, `https://faucet.circle.com`
- **Arc Mainnet — not launched as of 2026-06.** Testnet-only ecosystem. MVP targets Testnet exclusively; Mainnet support is a post-launch task once Circle ships.
- Arc Testnet:
  - Chain ID: `5042002`
  - RPC: `https://rpc.testnet.arc.network` (official) and `https://5042002.rpc.thirdweb.com` (thirdweb mirror)
  - USDC: `0x3600000000000000000000000000000000000000` — **system contract address**, USDC is native gas token on Arc (paid in USDC, not ETH).
  - Block explorer: `https://testnet.arcscan.app`
  - Faucet: `https://faucet.circle.com` (select Arc Testnet, 1 USDC/day)
  - **EIP-3009 support: assumed (Circle-native USDC implements it universally). Must be confirmed at integration time.** If missing, fallback is `permit2` or to switch chain.

### EIP-3009

- Spec: `https://eips.ethereum.org/EIPS/eip-3009`
- Function: `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)`
- EIP-712 domain (USDC v2 standard): `name="USDC", version="2", chainId, verifyingContract=<USDC address>`
- EIP-712 message type:
  ```
  TransferWithAuthorization(
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce
  )
  ```
- `nonce` is 32-byte client-generated random — token contract maintains `authorizationState[from][nonce]` mapping. Replay-protected at token layer.
- Signature ecrecovered against `from`. Anyone can submit (msg.sender unconstrained).

## Architecture implications

### Why facilitator-on-the-server changes everything

The original tech-spec design (agent submits tx, passes tx_hash to middleware) does not match the x402 standard. Standard model:

1. Agent gets 402 with `payTo = PaymentSplitter contract address`.
2. Agent signs EIP-3009 authorization off-chain: `from=agent, to=splitter, value=amount, nonce=random, validBefore=now+60s`.
3. Agent retries with `X-PAYMENT` containing base64(signature + authorization).
4. Middleware (acting as facilitator) verifies signature off-chain (no RPC needed) + ensures `to==splitterAddress`, `value>=required`, `validBefore > now`.
5. Middleware calls `splitter.payWithAuthorization(developerId, authorization, signature)` — middleware pays gas.
6. Inside contract: `splitter.payWithAuthorization()` calls `USDC.transferWithAuthorization(from, splitter, value, ...)`. USDC verifies signature (re-check at chain layer), transfers USDC from agent to splitter. Splitter then accounts: `developers[devId].balance += value - fee`, `platformBalance += fee`.
7. Middleware responds 200 with `X-PAYMENT-RESPONSE: base64({success, transaction: txHash, network, payer: from})`.

This requires:
- Middleware holds a relayer private key (configured via env var) — gas-paying account.
- Middleware has Arc-Testnet RPC URL + USDC ABI for signature verification.
- Splitter contract has new function `payWithAuthorization(developerId, value, validAfter, validBefore, nonce, v, r, s)` that delegates to USDC.transferWithAuthorization then accounts.

### Replay protection — solved naturally

- On-chain: USDC's own `authorizationState[from][nonce]` prevents the same EIP-3009 authorization being settled twice.
- API-level (same X-PAYMENT replayed against many API calls): middleware tracks consumed `nonce` per agent. Option (a) — in-memory `Set<nonce>`. Option (b) — derive nonce from the URL+timestamp at agent side. For MVP, option (a) is sufficient (sized eviction by validBefore expiry).

### Framework adapter strategy

`withPaywall()` cannot be both framework-agnostic AND use Express/Fastify/Next signature. Resolution:

- Core: `paywall(req: HttpRequest, options) -> Promise<PaywallResult>` — pure function. `HttpRequest` is a minimal shape `{ headers, method, url }`. Returns `{ status: 200, paymentResponseHeader }` or `{ status: 402, body, headers }`.
- Adapters (thin wrappers per framework):
  - `withPaywall(handler)` for Node http (`(req, res) => void`)
  - `fastifyPaywall(handler)` for Fastify (`(request, reply)`)
  - `nextPaywall(handler)` for Next.js App Router
- MVP ships: Node http + Fastify (matches `architecture.md` API stack). Others post-MVP.

### Developer registry semantics

Registry trade-off:
- Open (anyone can register any address): simple, gas-efficient. UX problem: registration is "claim" not "verify". Mitigation: documented as "any address can be registered, but only `msg.sender` of `withdraw()` controls the funds — so registration is permissionless opt-in, withdrawal is wallet-gated." Accept for MVP.
- Authenticated (`require(msg.sender == wallet)`): cleaner semantics but unusable from a hardware wallet onboarding flow with delegation. Defer to post-MVP.

### Wallet rotation

Not supported in MVP. If wallet compromised, funds at risk. Documented in `## Out of scope` of user-spec. Post-MVP: `rotateWallet(newWallet)` with signed challenge.

### Platform fee destination

Two ledgers in contract: `developers[id].balance` (per-developer) and `platformBalance` (single). `withdrawPlatformFees(to)` (owner-only) transfers `platformBalance` to address chosen at call time. Decouples contract-owner role from platform-treasury address. Removes the contradiction with `deployment.md PLATFORM_WALLET_ADDRESS`.

### Emergency stop

Add `Pausable` (OpenZeppelin). `pause()` and `unpause()` are owner-only. Paused: blocks `payWithAuthorization`, allows `withdraw` (so users not locked out of funds).

## Target file layout (greenfield)

```
packages/
  middleware/
    src/
      core.ts            # framework-agnostic paywall(req, options)
      adapters/
        node-http.ts     # withPaywall(handler)
        fastify.ts       # fastifyPaywall(handler)
      x402.ts            # 402 body builder + X-PAYMENT/X-PAYMENT-RESPONSE codec
      verify.ts          # off-chain EIP-712 signature verify (viem)
      settle.ts          # on-chain settle via splitter.payWithAuthorization
      networks.ts        # NETWORKS map: rpcUrl, usdcAddress, splitterAddress, chainId
      replay-store.ts    # in-memory consumed-nonce store with TTL eviction
      errors.ts          # structured x402 error response builders
      types.ts           # PaymentRequirements, PaymentPayload, exported types
    test/                # vitest
    package.json
    tsconfig.json

contracts/
  contracts/
    PaymentSplitter.sol
    interfaces/
      IPaymentSplitter.sol
  test/
    PaymentSplitter.test.ts
  deploy/
    01_deploy_splitter.ts
  hardhat.config.ts
  package.json

scripts/
  register.ts            # CLI to call splitter.register(wallet) for developers
```

## Open verification items (for implementation)

- Confirm EIP-3009 `transferWithAuthorization` is implemented on Arc Testnet system USDC at `0x3600...0000` — check explorer or call `versionString()` / EIP-712 domain separator.
- Confirm Arc Testnet supports standard EIP-712 chain ID encoding (it should, since EVM).
- Confirm RPC endpoint stability — thirdweb mirror is fallback if `rpc.testnet.arc.network` is rate-limited.
- Confirm `@circle-fin/x402-batching` (or successor) client SDK semantics for self-hosted facilitator URL injection.

## Known unknowns (deferred or accepted)

- Arc Mainnet chain ID and USDC address (project pre-launch by Circle, not actionable in MVP).
- Reorg depth on Arc Testnet — assume 1 block finality; document the assumption in `Verification Plan`.
- Behavior when USDC is paid as gas — settle tx itself costs USDC, not ETH. Relayer wallet must be funded in USDC, not native token.
