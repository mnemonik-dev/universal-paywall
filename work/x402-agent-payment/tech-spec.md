---
feature: x402-agent-payment
created: 2026-06-16
updated: 2026-06-16
status: draft
size: L
branch: dev
---

# Tech Spec: x402 Payment Flow for AI Agents

## Solution

Implement standard **x402 v1** for AI-agent payments on Arc Network Testnet, using a **per-developer vault factory** on-chain and a **self-hosted facilitator** inside the middleware. Three components ship together:

1. **`@universal-paywall/middleware`** — TypeScript npm package (ESM-only). Acts as both server (returns 402, gates resource) and self-hosted x402 facilitator: verifies EIP-712 typed-data signatures off-chain, settles `USDC.transferWithAuthorization` directly on-chain via a relayer wallet that pays gas in USDC. Framework-agnostic `paywall(req, opts)` core + thin adapters for Node http and Fastify.
2. **`PaymentSplitterFactory.sol` + `PaymentVaultImpl.sol`** (Arc Testnet, Solidity ^0.8.20, OpenZeppelin 5.x: `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `Initializable`, `Clones`, `SafeERC20`). Each developer's `register()` call deploys a deterministic minimal-proxy vault clone (EIP-1167) at `Clones.predictDeterministicAddress(impl, bytes20(developer))`. The vault is a passive ERC-20 receiver; fee split happens at `withdraw()`.
3. **Deploy + tooling** — Hardhat with Arc Testnet network, deploy script for factory, developer-onboarding CLI (`scripts/register.ts`), Wave 1 spike that verifies live Arc Testnet USDC contract exposes EIP-3009 + EIP-712 domain values, README.

**Why per-developer vaults (security-driven):** A shared splitter with a `developerId` argument is vulnerable to cross-developer payment-attribution attacks — an adversary can race-submit a captured X-PAYMENT to a different developer's middleware. With per-developer vaults, the EIP-3009 `to` field cryptographically binds the payment to a single recipient — the signature for `to=devA-vault` cannot be replayed against `devB-vault`. As a side effect, the open-registration griefing surface disappears (vault is owned by the EOA that registered it).

**Chain choice:** Arc Testnet only for MVP. Arc Mainnet is unreleased by Circle as of 2026-06. `arc-mainnet` is a `NETWORKS` placeholder gated by `enabled: false`, filled when Circle ships.

## Architecture

### What we're building/modifying

- **`packages/middleware/`** — npm package `@universal-paywall/middleware`
- **`contracts/`** — Hardhat project with `PaymentSplitterFactory.sol` + `PaymentVaultImpl.sol` + mock USDC for tests + verification spike script
- **`scripts/register.ts`** — CLI invoked by the developer to call `factory.register()` from their EOA

```
packages/middleware/src/
  index.ts             # public exports: withPaywall, fastifyPaywall, NETWORKS, types
  core.ts              # paywall(req, opts) — framework-agnostic facilitator pipeline
  adapters/
    node-http.ts       # withPaywall(handler, opts): (req, res) => Promise<void>
    fastify.ts         # fastifyPaywall(opts): FastifyPluginAsync
  x402.ts              # build402Body, encodeXPaymentResponse, decodeXPayment (incl. 4 KB size cap)
  verify.ts            # verifyEip3009Authorization via viem.recoverTypedDataAddress
  settle.ts            # settleOnChain → USDC.transferWithAuthorization (with timeout, error taxonomy)
  replay-store.ts      # NonceStore: synchronous has+insert, TTL eviction, 100k cap
  networks.ts          # NETWORKS map: arc-testnet alias + eip155:5042002 canonical
  errors.ts            # buildErrorResponse(reason): typed 402/400 responses
  relayer-key.ts       # opaque, non-enumerable wrapper around private key
  types.ts             # PaymentRequirements, PaymentPayload, FacilitatorConfig, NetworkConfig
  __tests__/
contracts/
  contracts/
    PaymentSplitterFactory.sol
    PaymentVaultImpl.sol
    interfaces/IERC3009.sol
    mocks/MockUsdcEip3009.sol
  test/
    PaymentSplitterFactory.test.ts
    PaymentVaultImpl.test.ts
    integration/forked-e2e.test.ts   # CI-default, mock USDC + factory + vault + middleware
  scripts/
    verify-usdc-eip3009.ts           # Wave 1 spike against live Arc Testnet
  deploy/
    01_deploy_factory.ts
  hardhat.config.ts
scripts/
  register.ts                         # tsx CLI invoking factory.register() from developer EOA
```

### How it works

Happy-path sequence:

```
1.  Agent → GET /api/data              (no X-PAYMENT header)
2.  Adapter normalizes req → core.paywall(req, opts)
3.  core: no header → build402Body() with PaymentRequirements pointing at
       payTo = factory.computeVaultAddress(developerEoa)  (pure computation)
       asset = NETWORKS[network].usdcAddress
       network = "eip155:5042002" (canonical CAIP-2 form; alias "arc-testnet" accepted on inbound)
       extra.assetTransferMethod = "eip3009"
       extra.name = NETWORKS[network].usdcEip712Name (read at deploy/start time)
       extra.version = "2"
     → return { status: 402, headers: {content-type: application/json}, body }
4.  Adapter writes 402 response

5.  Agent signs EIP-712 TransferWithAuthorization off-chain (no broadcast)
       domain  = { name: usdcEip712Name, version: "2",
                   chainId, verifyingContract: usdcAddress }
       message = { from, to: developerVault, value, validAfter, validBefore, nonce }
6.  Agent → GET /api/data
       X-PAYMENT: base64(JSON({
         x402Version: 1, scheme: "exact", network,
         payload: { signature, authorization }     // strictly {signature, authorization}
       }))

7.  core.paywall:
    a. read X-PAYMENT, check Buffer.byteLength <= 4096 → else HTTP 400 "header_too_large"
    b. decodeXPayment → PaymentPayload (HTTP 400 "malformed_payment_header" on parse error)
    c. verifyEip3009Authorization:
       - recoverTypedDataAddress(domain, types, message, signature) == authorization.from
       - to == computeVaultAddress(opts.developerEoa)
       - value >= maxAmountRequired (BigInt compare)
       - validBefore > now + 5 000 ms
       - validAfter <= now
       - payload.network normalize equals opts.network normalize (CAIP-2 ↔ alias)
       - SYNCHRONOUS: replayStore.has({from, nonce}) → false; insert (no await between)
    d. Off-chain factory state checks via PublicClient.readContract (cached):
       - factory.paused() === false → else 402 "paused"
       - factory.vaults(developerEoa) !== 0x0 → else 402 "vault_not_deployed"
    e. settleOnChain:
       - WalletClient.writeContract: USDC.transferWithAuthorization(
           from, to=vault, value, validAfter, validBefore, nonce, v, r, s
         )
       - publicClient.waitForTransactionReceipt({hash, timeout: 30_000})
       - on success: tx hash + receipt.status === 'success' → ok
       - on classified failure: rpc_timeout / rpc_5xx / gas_estimate_revert /
                                mine_timeout / receipt_reverted /
                                relayer_no_balance / authorization_already_used_onchain
         → 402 "settlement_failed" + reason
         (on failure, leave replay-store entry intact to avoid one X-PAYMENT
          being retried infinitely with the same nonce; agent must mint a new nonce)
    f. on success, set X-PAYMENT-RESPONSE = base64(JSON({success:true, transaction,
       network, payer: authorization.from}))
    g. return { passthrough: true, responseHeaders }

8.  Adapter sets response headers, invokes user's handler → 200 + resource
```

### Shared resources

| Resource | Owner (creates) | Consumers | Instance count |
|----------|----------------|-----------|----------------|
| viem `PublicClient` (Arc RPC reader) | `core.ts` (lazy-init per `network`) | `verify.ts`, `settle.ts`, factory-state cache | 1 per network in use within a process |
| viem `WalletClient` (relayer signer) | `core.ts` (lazy-init per `network`+`relayerKey`) | `settle.ts` | 1 per network in use within a process |
| `NonceStore` (in-memory `Map<from, Map<nonce, validBefore>>`, 100k cap) | `core.ts` (process-singleton) | `verify.ts` | 1 per process — **single-process scope** (multi-instance support is post-MVP) |
| `factory.paused()` / `factory.vaults` cache (TTL 5 s) | `core.ts` | factory-state checks in `core.ts` | 1 per network |
| `NETWORKS` registry (module const) | `networks.ts` | all middleware modules, deploy scripts, register CLI | 1 (compile-time) |
| `OpaqueRelayerKey` wrapper | adapter/index.ts (consumer constructs) | `settle.ts` only | 1 per network |

## Decisions

### D1: Adopt standard x402 v1 wire format strictly

**Decision:** 402 body is `{x402Version:1, accepts:[PaymentRequirements], error?}` (`application/json`). X-PAYMENT is base64 JSON `{x402Version, scheme, network, payload}` where `payload` is strictly `{signature, authorization}` — no custom fields. X-PAYMENT-RESPONSE is base64 JSON `{success, transaction, network, payer}`. Network IDs accepted as CAIP-2 (`eip155:5042002`) AND alias (`arc-testnet`); canonical form on outbound is CAIP-2.
**Rationale:** Supports user-spec "любой x402 v1-совместимый клиент работает". Verified against `github.com/coinbase/x402/specs/schemes/exact/scheme_exact_evm.md`. Any deviation breaks interop with CDP/Circle SDKs.
**Alternatives considered:** Custom header with extra fields (earlier draft put `developerId` in payload) — rejected, breaks off-the-shelf clients.

### D2: EIP-3009 `transferWithAuthorization`, settled directly by facilitator

**Decision:** Middleware (facilitator) calls `USDC.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` directly on the USDC token contract. No contract wrapper at settle time. `from` is passed as explicit argument per EIP-3009.
**Rationale:** Supports user-spec Middleware AC "EIP-712 ecrecover + on-chain settle". Matches the only signature standard accepted by the x402 `exact` scheme on EVM. Removes an entire layer of custom Solidity (the prior `payWithAuthorization(developerId, …)` wrapper) and the cross-developer attack with it.
**Alternatives considered:**
- EIP-2612 permit: rejected — not part of x402 spec.
- Wrapper contract that calls `USDC.transferWithAuthorization` internally: rejected — the `from` argument is unverifiable from the splitter's perspective (USDC uses `from` as-given, doesn't ecrecover it), so the only safety check is the EIP-712 signature, which is already verifiable off-chain by the facilitator.

### D3: Per-developer vault via EIP-1167 minimal proxy + factory

**Decision:** `PaymentSplitterFactory.register()` deploys `Clones.cloneDeterministic(vaultImpl, bytes32(uint256(uint160(msg.sender))))`. The vault is a passive USDC receiver. `payTo` in 402 response is the deterministic vault address (off-chain computable via `Clones.predictDeterministicAddress`).
**Rationale:** Supports user-spec "non-custodial split" + closes the cross-developer attack surface (`to` field cryptographically binds payment to a single vault) + closes the open-registration griefing surface (vault is owned by the EOA that registered).
**Alternatives considered:**
- Shared splitter + `developerId` argument: rejected — race-replay attack via captured X-PAYMENT.
- Direct-to-developer-EOA `payTo` (no vault): considered — eliminates on-chain fee. Kept for the **free-tier** path in `project.md` (open-source middleware can omit the factory and set `payTo = developerEoa`); for the **paid hosted tier** of this MVP, vault is required to enable on-chain platform fee.

### D4: Vault holds gross USDC; fee split happens at `withdraw()`

**Decision:** `vault.withdraw()` (callable only by `developer`, `nonReentrant`) reads `usdc.balanceOf(this)` as gross, computes `fee = gross * factory.feeBps() / 10000`, sends `gross - fee` to developer and `fee` to `factory.platformTreasury()`. No `withdraw(amount)` partial — full balance only, to avoid fee-rounding gaming.
**Rationale:** ERC-20 has no receive-callback, so the vault cannot split on payment arrival. Splitting on withdraw is the simplest correct model and avoids dust accumulation (`gross - fee` is exact integer). [TECHNICAL]
**Alternatives considered:** Partial `withdraw(amount)` — rejected, lets developer game small withdrawals where `amount * fee / 10000 == 0` (truncation) to bypass fees.

### D5: Two-layer replay protection (off-chain NonceStore + on-chain USDC `authorizationState`)

**Decision:**
- On-chain: USDC's `authorizationState[from][nonce]` (built into EIP-3009).
- API-level: middleware `NonceStore`, a per-process `Map<from, Map<nonce, validBefore>>`. `has` and `insert` execute as a single synchronous block (no `await` between). Lazy TTL eviction on every `has` call. Hard cap 100k entries; eviction by oldest `validBefore` on overflow.

**Rationale:** Supports user-spec AC "Повторный (from, nonce) → 402 nonce_already_used" + "На уровне USDC nonce также защищён". TOCTOU-safe by spec contract. Single-process scope is explicit limitation; multi-instance support uses Redis-backed store post-MVP.
**Alternatives considered:** Server-issued challenge bound into 402 — adds latency. Rejected.

### D6: Framework-agnostic core + per-framework adapters

**Decision:** `core.ts` exports `paywall(req, opts)` taking `{headers, method, url}`. Adapters in `adapters/`: `node-http.ts` (`withPaywall(handler)`) and `fastify.ts` (`fastifyPaywall(opts)`). Next.js / Hono / Bun adapters post-MVP.
**Rationale:** Supports user-spec ACs "exports withPaywall and fastifyPaywall". Resolves the contradiction in the original AC ("framework-agnostic `(req, res)`").
**Alternatives considered:** Single Node-http signature — doesn't fit Fastify cleanly.

### D7: viem 2.x for all EVM interaction

**Decision:** Use `viem` for EIP-712 typed-data ecrecover (`recoverTypedDataAddress`), `PublicClient` (reads, chain ID check, receipt awaiting), `WalletClient` (relayer signing). USDC ABI loaded statically (no auto-generation).
**Rationale:** [TECHNICAL] In `architecture.md` dependencies. TypeScript-native, tree-shakable, pure-function API matches middleware.
**Alternatives considered:** ethers.js — bulkier, class-based.

### D8: Solidity ^0.8.20; OpenZeppelin 5.x with `Ownable2Step` + storage-based `ReentrancyGuard`

**Decision:** Pragma `^0.8.20`. Use `@openzeppelin/contracts` 5.x: `Ownable2Step`, `Pausable`, `ReentrancyGuard` (storage-based, NOT `ReentrancyGuardTransient`), `Initializable`, `Clones`, `SafeERC20`, `IERC20`.
**Rationale:** [TECHNICAL] OZ 5.x requires ≥0.8.20. `Ownable2Step` reduces owner-key-compromise blast radius (two-step transfer). Storage-based `ReentrancyGuard` chosen because Arc Testnet's transient-storage support (EIP-1153) is not yet verified — `ReentrancyGuardTransient` would brick if unsupported.
**Alternatives considered:** OZ 4.x — older patterns. `ReentrancyGuardTransient` — deferred until Arc 1153 support confirmed.

### D9: Hardhat over Foundry

**Decision:** Hardhat for tests + deploy.
**Rationale:** [TECHNICAL] `architecture.md` lists Hardhat. TypeScript-native tests align with the monorepo.

### D10: Configurable platform fee — owner-only, 0–1000 bps, default 50 bps

**Decision:** `factory.setFeeBps(uint16 bps)` revert if `bps > 1000`. Default 50 bps in constructor. Emits `FeeBpsUpdated(uint16 oldBps, uint16 newBps)`. Vault reads `factory.feeBps()` at withdraw time (no per-vault state).
**Rationale:** Supports user-spec AC "default 50 bps, hard cap 1000 bps". Matches `patterns.md`. Reading via factory means a fee change applies to all future withdrawals across all vaults — explicit, owner-controlled.

### D11: `platformTreasury` settable, separate from `owner`

**Decision:** Factory stores `platformTreasury` (settable by owner via `setPlatformTreasury(address)`). All vault withdrawals route the fee portion there. `owner` and `platformTreasury` are independent addresses.
**Rationale:** [TECHNICAL] Decouples the owner key (a multisig admin role) from the treasury receiver. Matches `deployment.md PLATFORM_TREASURY_ADDRESS`.

### D12: `Pausable` is off-chain checked by middleware

**Decision:** Factory inherits `Pausable`. Vaults do NOT check `factory.paused()` (vaults always allow `withdraw`). Middleware reads `factory.paused()` (cached 5 s) before settle; if true, returns 402 `"error": "paused"`.
**Rationale:** [TECHNICAL] On-chain pause cannot block raw `USDC.transferWithAuthorization` calls to a vault (USDC doesn't know about the factory). Off-chain pause is sufficient for a self-hosted facilitator. Developers never blocked from withdrawing their accumulated funds.

### D13: Relayer key handled as opaque, non-enumerable wrapper

**Decision:** Introduce `OpaqueRelayerKey` type whose private field is non-enumerable + `toJSON()`/`toString()` redact. `settle.ts` is the only consumer that extracts the underlying key (via a private symbol). All error handling redacts unknown stack content matching `0x[0-9a-fA-F]{64}`.
**Rationale:** Mitigates accidental leak via `console.log(config)`, `JSON.stringify(config)`, error stack capture. [TECHNICAL] — not in user-spec, security-driven.

### D14: Startup chainId pin + rpcUrl trust

**Decision:** On first use of a `network`, middleware calls `publicClient.getChainId()` and asserts it equals `NETWORKS[network].chainId`. Mismatch throws `NetworkMismatchError`. `facilitator.rpcUrl` overrides the default; the chain ID check protects against pointing at a wrong-chain RPC.
**Rationale:** Mitigates SSRF / signed-tx-replay attack vector where a user-supplied `rpcUrl` could be configured to a different chain and accidentally settle there. [TECHNICAL]

## Data Models

### Contract storage

`PaymentSplitterFactory.sol`:
```solidity
IERC20 public immutable usdc;
address public platformTreasury;
uint16 public feeBps;            // 0..1000
address public immutable vaultImpl;
mapping(address developer => address vault) public vaults;

event VaultDeployed(address indexed developer, address vault);
event FeeBpsUpdated(uint16 oldBps, uint16 newBps);
event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);
event Paused();
event Unpaused();
```

`PaymentVaultImpl.sol`:
```solidity
address public developer;     // set in initialize, then immutable in practice
address public factory;       // set in initialize, then immutable in practice
bool private _initialized;    // Initializable

event Withdrawal(address indexed developer, uint256 gross, uint256 fee);
```

Custom errors (gas-efficient):
```solidity
error NotDeveloper();
error AlreadyRegistered();
error InvalidFeeBps();
error ZeroAddress();
error NoBalance();
```

### Middleware types (TypeScript, ESM)

```ts
export interface NetworkConfig {
  id: string;                     // canonical CAIP-2 ('eip155:5042002')
  alias: string;                  // 'arc-testnet'
  chainId: number;                // 5042002
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  usdcEip712Name: string;         // verified from USDC.name() — likely "USD Coin"
  usdcEip712Version: string;      // "2"
  factoryAddress: `0x${string}`;
  vaultImplAddress: `0x${string}`;
  enabled: boolean;               // false until deploy completes
}

export interface OpaqueRelayerKey {
  // private; opaque tag; settle.ts extracts via symbol
}

export interface PaywallConfig {
  price: string;                  // '0.01' — USD-denominated
  developerEoa: `0x${string}`;
  network: string;                // 'arc-testnet' | 'eip155:5042002'
  facilitator: {
    mode: 'inline';
    relayerKey: OpaqueRelayerKey;
    rpcUrl?: string;
  };
  resource?: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;                // canonical CAIP-2 on output
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  asset: `0x${string}`;
  extra: { assetTransferMethod: 'eip3009'; name: string; version: string };
}

export interface ExactEvmPayload {                  // STRICTLY these two fields
  signature: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  payload: ExactEvmPayload;
}
```

## Dependencies

### New (middleware)
- `viem` 2.x
- `vitest`, `ajv` (JSON Schema for 402 body shape), `tsup` (bundle), `tsx` (test/CLI runner)

### New (contracts)
- `@openzeppelin/contracts` ^5.0.0 — `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `Initializable`, `Clones`, `SafeERC20`, `IERC20`
- `hardhat`, `@nomicfoundation/hardhat-toolbox`, `@nomicfoundation/hardhat-verify`

### Reused from project
- TypeScript, ESLint, Prettier, gitleaks pre-commit.

## Testing Strategy

**Feature size:** L — three-tier coverage required.

### Unit tests (vitest, in `packages/middleware/`) — ≥85% line coverage
- x402 codec: 402 body builder produces spec-compliant JSON (ajv-validated against vendored x402 v1 schema); decoder handles missing/invalid fields; header size cap.
- Network id normalization (CAIP-2 ↔ alias) round-trips.
- `verify.ts`:
  - Valid signature passes.
  - Tampered chainId → fail.
  - Tampered verifyingContract → fail.
  - Tampered domain.name → fail.
  - Tampered domain.version → fail.
  - `to != computedVaultAddress` → fail.
  - `value < required` → fail.
  - `validBefore <= now + 4s` → fail; `validBefore == now + 6s` → pass (5 s safety margin boundary).
  - `validAfter > now` → fail (returns `authorization_not_yet_valid`).
  - Network mismatch → fail.
- `replay-store.ts`: synchronous has+insert; TTL eviction; 100k cap eviction; same `(from, nonce)` twice → reject.
- `settle.ts`: classified failure-mode taxonomy — `rpc_timeout`, `rpc_5xx`, `gas_estimate_revert`, `mine_timeout`, `receipt_reverted`, `relayer_no_balance`, `authorization_already_used_onchain`. Each mocked + asserted on the resulting 402 reason.
- `relayer-key.ts`: `JSON.stringify` redacts; `toString` redacts; error stacks redact 0x[a-f0-9]{64} patterns; non-enumerable.
- `errors.ts`: each error reason produces a canonical body matching the schema.
- Price parsing: `'0.01'` → `10000n`; `'1.5'` → `1500000n`; reject `'1.2345678'`, `'abc'`, `''`, `'-1'`, `'0'`, `'1e2'`, `' 1 '`.

### Contract tests (Hardhat + chai, ≥95% branch coverage)
- `PaymentSplitterFactory.test.ts`:
  - `register`: deploys vault at predicted address; `vaults[developer]` populated; idempotent re-call reverts `AlreadyRegistered`; paused → reverts `EnforcedPause` (OZ 5.x); vault `initialize` called once with `_developer = msg.sender`.
  - `setFeeBps`: owner-only; revert `InvalidFeeBps` on `bps > 1000`; emits.
  - `setPlatformTreasury`: owner-only; revert `ZeroAddress`; emits.
  - `Ownable2Step` two-step transfer happy path + cancel.
  - `pause`/`unpause`: owner-only.
  - Constructor reverts on zero usdc/treasury/feeBps > 1000.
- `PaymentVaultImpl.test.ts` (via clone deployed in test fixture):
  - `initialize` is single-call; reverts on second call.
  - `withdraw`: developer-only; no-balance reverts `NoBalance`; happy path splits gross→developer/fee→treasury; emits `Withdrawal(developer, gross, fee)`.
  - Fee edge cases: `feeBps = 0` → `fee = 0`, no second transfer; `feeBps = 1000` → 10% fee; `gross = 1` micro-USDC → `fee = 0` (truncation), full 1 unit to developer.
  - Reentrancy: malicious treasury that re-enters `withdraw` is blocked by `ReentrancyGuard`.
  - Withdraw works when factory is `paused()` (developers not locked out).
- Forked-integration: `forked-e2e.test.ts` (runs in CI, no env gate) — deploys mock USDC with EIP-3009 + factory + vault + middleware (in-process node http server), runs the full happy path and replay-rejection path, asserts: 200 received, vault USDC balance increased by `value`, NonceStore rejects same-nonce retry, on-chain `usdc.authorizationState(from, nonce)` is true after settle.

### E2E (gated by `ARC_TESTNET_E2E=1`, nightly job)
- Real EIP-3009 signer against deployed factory + vault on Arc Testnet via real RPC.
- Asserts: 402 schema, 200 + X-PAYMENT-RESPONSE, vault USDC balance increased.

## Agent Verification Plan

**Source:** user-spec sections "Критерии приёмки" and "Флоу".

### Verification approach
- Per-task `Verify-smoke` checks (specified per task below): TypeScript build, vitest, hardhat compile/test/coverage, hardhat deploy dry-run on local node, register CLI smoke, integration test on the forked node, live Arc Testnet read.
- Final Wave QA walks every user-spec + tech-spec AC.

### Tools required
- bash + curl (HTTP smoke).
- Hardhat CLI.
- viem (programmatic, not MCP).
- No Playwright / Telegram MCP needed.

## Risks

| Risk | Mitigation |
|------|-----------|
| Arc Testnet USDC doesn't expose `transferWithAuthorization` as expected. | Wave 1 Task 3 spike reads `name`, `version`, `decimals`, selector for `transferWithAuthorization` and `authorizationState`. If absent, surface to user and pivot chain (Base Sepolia is the fallback). |
| Arc USDC dual interface (18-decimal native gas vs 6-decimal ERC-20). | All facilitator math uses ERC-20 view (6 decimals). Spike asserts `decimals() == 6`. Test fixtures use 6-decimal mock. |
| Relayer wallet exhausts USDC mid-settle (Arc gas paid in USDC). | Pre-deploy QA verifies relayer USDC ≥ 1. Settlement classifier surfaces `relayer_no_balance`. README documents the operational monitoring. Auto-refill is out of MVP scope. |
| `NonceStore` is per-process → multi-instance breaks replay protection. | Explicit single-process limitation documented in user-spec "Что не входит" and in `replay-store.ts` source comment. Redis-backed multi-instance store is post-MVP. |
| Arc Testnet RPC instability. | `facilitator.rpcUrl` overridable. Fallback mirror `https://5042002.rpc.thirdweb.com` documented. |
| EIP-712 chain-replay attack. | Domain pins `chainId` + `verifyingContract`. Test cases tamper each of `chainId`, `verifyingContract`, `name`, `version` and assert verify fails. D14 enforces startup chainId pin against the configured network. |
| Owner-key compromise → fee maxed or treasury rerouted. | `Ownable2Step` reduces accidental loss. README + `deployment.md` recommend multisig (e.g. Safe) as initial owner. Not enforced in contract. |
| Cross-developer payment-attribution attack on shared splitter. | Architecturally eliminated by per-developer vault (D3): EIP-3009 `to` cryptographically binds payment to a single vault address. |
| Open-registration griefing on developer registry. | Architecturally eliminated by per-developer vault: `register()` always uses `msg.sender` as the vault's immutable owner; an adversary registering someone else's address yields a vault they can't withdraw from. |
| Settle rate-limit / back-pressure abuse. | Documented limitation; defer to post-MVP (operational). |
| Settlement failure mid-flight (replay-store entry inserted, on-chain revert) — does the agent get stuck? | Agent must mint a new nonce on retry. `nonce_already_used` returned for old nonce; agent SDKs handle this by picking a fresh nonce. Documented in README. |
| Arc 1153 (transient storage) support unverified → `ReentrancyGuardTransient` would brick. | Use storage-based `ReentrancyGuard` (D8). |
| HTTPS-MITM / adversarial proxy intercepts X-PAYMENT. | Per-developer vault eliminates the payment-redirect vector (signature is to a single vault). Network mismatch check + nonce reuse rejection make pure replay impossible. Beyond this, infrastructure-level (TLS + CT) is the developer's responsibility. |

## User-Spec Deviations

All deviations were resolved by rewriting user-spec in lockstep with this tech-spec (revision 2026-06-16). The current user-spec is fully consistent with this tech-spec.

- **From original draft: `payWithAuthorization` shared-splitter design → per-developer vault factory.** Driven by security findings (cross-developer attack, open-registration griefing). User-spec ACs rewritten to specify factory + vault, vault address as `payTo`, `vault.withdraw()` only.
- **From original draft: arc-mainnet target → arc-testnet only.** Arc Mainnet not launched.
- **From original draft: developerId argument in X-PAYMENT payload → removed.** Standard x402 has no such field; per-developer vault makes it unnecessary (recipient determined by `to`).
- **Added: `Pausable` factory + off-chain pause read.** Standard money-handling safety.
- **Added: `Ownable2Step` for factory ownership.** Mitigates owner-key compromise.
- **Added: Settlement failure taxonomy (7 reasons).** From security/test review.
- **Added: `OpaqueRelayerKey` wrapper.** Security review finding.
- **Added: Startup chainId pin.** Security review finding (D14).
- **Added: X-PAYMENT 4 KB size cap; malformed → HTTP 400.** Security + completeness review.
- **Wallet rotation / unregister explicitly out of scope.**
- **Multi-instance NonceStore explicitly out of scope.**
- **Auto-refill relayer wallet explicitly out of scope.**

→ **[PENDING USER APPROVAL]** — entire user-spec + tech-spec set, post-rewrite.

## Acceptance Criteria

Technical AC complementing user-spec:

- [ ] `npm install && npm run build --workspace=packages/middleware` succeeds; package is ESM-only (`"type": "module"`, no CJS export).
- [ ] `cd contracts && npx hardhat compile` succeeds; pragma `^0.8.20`; OpenZeppelin 5.x imports resolve.
- [ ] `cd contracts && npx hardhat test` passes with ≥95% branch coverage on both contracts.
- [ ] `npm test --workspace=packages/middleware` passes; ≥85% line coverage on `src/`.
- [ ] Forked integration test (`forked-e2e.test.ts`) passes in CI without env flag.
- [ ] Live Arc Testnet test (`arc-testnet-e2e.test.ts`) passes when `ARC_TESTNET_E2E=1`.
- [ ] Deploy script outputs factory address; verifiable on `https://testnet.arcscan.app`.
- [ ] No secrets committed; gitleaks blocks key-shaped patterns.
- [ ] Middleware bundle <30 KB minified+gzip (excluding `viem`).
- [ ] `packages/middleware/package.json`: `engines.node: ">=20"`, exports map ESM-only.

## Implementation Tasks

### Wave 1 — Project setup (parallel)

#### Task 1: Monorepo scaffolding (ESM-only)
- **Description:** Initialize npm workspace root with `packages/middleware`, `contracts`, `scripts`. TypeScript strict, ESLint, Prettier, gitleaks pre-commit. `packages/middleware/package.json` — name `@universal-paywall/middleware`, `"type": "module"`, exports map ESM-only, tsup build, `engines.node: ">=20"`.
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `npm install && npm run lint && npm run build --workspace=packages/middleware`
- **Files to modify:** `package.json`, `packages/middleware/{package.json,tsconfig.json,tsup.config.ts}`, `.eslintrc.cjs`, `.prettierrc`, `.husky/pre-commit`
- **Files to read:** `.gitignore`, `CLAUDE.md`, `.claude/skills/project-knowledge/references/patterns.md`

#### Task 2: Hardhat setup
- **Description:** Hardhat TS in `contracts/`. Arc Testnet network (chainId 5042002, RPC, accounts from env). `@openzeppelin/contracts@^5.0.0`, `@nomicfoundation/hardhat-toolbox`, `@nomicfoundation/hardhat-verify`. Pragma `^0.8.20`.
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat compile`
- **Files to modify:** `contracts/{hardhat.config.ts,package.json,tsconfig.json}`
- **Files to read:** `package.json`, `.claude/skills/project-knowledge/references/architecture.md`

#### Task 3: Verify Arc Testnet USDC supports EIP-3009 (spike)
- **Description:** Hardhat script that hits Arc Testnet RPC, confirms USDC `0x3600…` exposes `transferWithAuthorization` (selector `0xef55bec6`) + `authorizationState(address,bytes32)`. Reads `name()`, `version()`, `decimals()`. Patches `NETWORKS.arc-testnet.usdcEip712Name/version/expectedDecimals==6`.
- **Skill:** code-writing
- **Reviewers:** code-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat run scripts/verify-usdc-eip3009.ts --network arcTestnet` prints `{name, version, decimals, supportsEip3009: true}`
- **Files to modify:** `contracts/scripts/verify-usdc-eip3009.ts`
- **Files to read:** `contracts/hardhat.config.ts`

### Wave 2 — Smart contracts (sequential, after Wave 1)

#### Task 4: Factory + Vault contracts
- **Description:** Implement `PaymentSplitterFactory` and `PaymentVaultImpl` per Decisions D3/D4/D10/D11/D12/D8 and Data Models. Factory: `Ownable2Step`, `Pausable`; `register()`, `computeVaultAddress`, `setFeeBps`, `setPlatformTreasury`, `pause`/`unpause`. Vault: `Initializable`, `ReentrancyGuard`; `initialize`, `withdraw`. Mock USDC with EIP-3009 implementation for tests. `IERC3009` interface (off-chain ABI helper).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat compile`
- **Files to modify:** `contracts/contracts/{PaymentSplitterFactory.sol, PaymentVaultImpl.sol, interfaces/IERC3009.sol, mocks/MockUsdcEip3009.sol}`
- **Files to read:** `work/x402-agent-payment/user-spec.md`, `.claude/skills/project-knowledge/references/patterns.md`

#### Task 5: Contract tests
- **Description:** Hardhat + chai tests per Testing Strategy → "Contract tests". Cover both contracts; mock USDC; `Ownable2Step` happy path + cancel; reentrancy attempt with malicious treasury; fee math edge cases (0 / max / dust); withdraw-while-paused; constructor revert paths. ≥95% branch coverage.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat coverage`
- **Files to modify:** `contracts/test/{PaymentSplitterFactory.test.ts, PaymentVaultImpl.test.ts}`
- **Files to read:** `contracts/contracts/PaymentSplitterFactory.sol`, `contracts/contracts/PaymentVaultImpl.sol`

### Wave 3 — Middleware pure modules (parallel, after Wave 1)

#### Task 6: Types, NETWORKS, x402 codec, errors
- **Description:** `networks.ts` (NETWORKS keyed by both alias `arc-testnet` and CAIP-2 `eip155:5042002`; usdcEip712Name/version stubbed pending Task 3 patch). `types.ts` (all exported TS types per Data Models). `x402.ts` (`build402Body`, `decodeXPayment` with 4 KB size cap + strict `{signature, authorization}` shape, `encodeXPaymentResponse`; ajv-friendly). `errors.ts` (one builder per error reason; HTTP 400 vs 402 split per Solution). Pure functions, no I/O.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- src/__tests__/{x402,errors,networks}.test.ts`
- **Files to modify:** `packages/middleware/src/{networks.ts,types.ts,x402.ts,errors.ts}`
- **Files to read:** `work/x402-agent-payment/code-research.md`, `work/x402-agent-payment/user-spec.md`

#### Task 7: Relayer key wrapper + replay store
- **Description:** `relayer-key.ts` (`OpaqueRelayerKey` non-enumerable wrapper, redacted `toJSON`/`toString`, `extractSecret` private-symbol accessor). `replay-store.ts` (`NonceStore` class: synchronous `has` + `insert` block, TTL eviction on `has`, 100k cap with oldest-`validBefore` FIFO eviction).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- src/__tests__/{relayer-key,replay-store}.test.ts`
- **Files to modify:** `packages/middleware/src/{relayer-key.ts,replay-store.ts}`
- **Files to read:** `packages/middleware/src/types.ts`

### Wave 4 — Middleware facilitator (parallel, after Waves 2+3)

#### Task 8: Verify + Settle
- **Description:** `verify.ts` (`verifyEip3009Authorization(payload, ctx)` — viem `recoverTypedDataAddress` with domain from NETWORKS; per-spec checks per Solution step 7c; classifies network mismatch + nonce reuse + validity windows). `settle.ts` (`settleOnChain` — WalletClient writeContract to USDC.transferWithAuthorization with explicit `from` parameter; `waitForTransactionReceipt({timeout: 30_000})`; classifier mapping any failure to one of the 7 settlement reasons; relayer key extracted via OpaqueRelayerKey symbol; chainId pin check on first call per D14).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- src/__tests__/{verify,settle}.test.ts`
- **Files to modify:** `packages/middleware/src/{verify.ts,settle.ts}`
- **Files to read:** `packages/middleware/src/{x402.ts,networks.ts,replay-store.ts,relayer-key.ts}`, `contracts/contracts/interfaces/IERC3009.sol`

#### Task 9: Core orchestrator + adapters + index
- **Description:** `core.ts` (`paywall(req, opts)` → orchestrates: header-size check, decode, verify, factory-state cache (paused / vaults), settle, response). `adapters/node-http.ts` (`withPaywall(handler, opts)`). `adapters/fastify.ts` (`fastifyPaywall(opts)`). `index.ts` (public exports).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm run build --workspace=packages/middleware && node -e "import('@universal-paywall/middleware').then(m=>console.log(Object.keys(m)))"`
- **Files to modify:** `packages/middleware/src/{core.ts,adapters/node-http.ts,adapters/fastify.ts,index.ts}`
- **Files to read:** `packages/middleware/src/{verify.ts,settle.ts,errors.ts,x402.ts}`

### Wave 5 — Tests + tooling + integration (parallel, after Wave 4)

#### Task 10: Middleware unit tests
- **Description:** Vitest suite per Testing Strategy → "Unit tests". Covers all modules; ajv-validate the 402 body against a vendored x402 v1 JSON Schema; mock viem RPC; relayer-key redaction tests; replay-store TOCTOU and cap tests. ≥85% line coverage.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- --coverage`
- **Files to modify:** `packages/middleware/src/__tests__/*.test.ts`, `packages/middleware/src/__tests__/fixtures/x402-v1.schema.json`
- **Files to read:** all of `packages/middleware/src/`

#### Task 11: Forked integration test + Arc Testnet e2e (gated)
- **Description:** `contracts/test/integration/forked-e2e.test.ts` — runs in CI by default; deploys mock USDC + factory + vault; spawns an in-process Node http server using `withPaywall()` AND a separate Fastify server using `fastifyPaywall()`; runs the full happy path and replay-rejection path against both. `packages/middleware/__tests__/integration/arc-testnet-e2e.test.ts` — gated on `ARC_TESTNET_E2E=1`; hand-rolled EIP-3009 signer against live Arc Testnet. Both assert: 200 received, vault USDC balance increased, NonceStore rejects retry.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat test test/integration/forked-e2e.test.ts`
- **Files to modify:** `contracts/test/integration/forked-e2e.test.ts`, `packages/middleware/__tests__/integration/arc-testnet-e2e.test.ts`
- **Files to read:** `packages/middleware/src/index.ts`, `contracts/contracts/PaymentSplitterFactory.sol`, `contracts/contracts/PaymentVaultImpl.sol`

#### Task 12: Deploy script + register CLI + README
- **Description:** `contracts/deploy/01_deploy_factory.ts` — deploys `PaymentSplitterFactory(usdcAddress, treasuryAddress, 50)`, prints factory address + vaultImpl address; calls `hardhat-verify` against arcscan. Patches `packages/middleware/src/networks.ts` with deployed addresses. `scripts/register.ts` — `tsx` CLI: `--network`, reads `REGISTER_KEY` env, calls `factory.register()` from EOA. Writes `README.md`: faucet → register → install middleware → run server.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** dry-run on local Hardhat node: `cd contracts && npx hardhat node` (separate terminal) + `npx hardhat run deploy/01_deploy_factory.ts --network localhost`
- **Verify-user:** Read `README.md`; the steps work when followed by a new developer.
- **Files to modify:** `contracts/deploy/01_deploy_factory.ts`, `scripts/register.ts`, `README.md`, `packages/middleware/src/networks.ts`
- **Files to read:** `contracts/contracts/PaymentSplitterFactory.sol`, `contracts/hardhat.config.ts`

### Audit Wave (parallel, after Wave 5)

#### Task 13: Code Audit
- **Description:** Full-feature code quality audit. Read every source file in `packages/middleware/src/`, `contracts/contracts/`, `scripts/`, `contracts/deploy/`, `contracts/scripts/`. Holistic review: shared resources, adapter consistency, naming, error handling, framework-adapter parity. Write `work/x402-agent-payment/audit-code.md`.
- **Skill:** code-reviewing
- **Reviewers:** none

#### Task 14: Security Audit
- **Description:** Full-feature security audit. OWASP middleware (X-PAYMENT validation, relayer key handling, RPC trust, integer math). Solidity: reentrancy, access control, event emissions, Pausable correctness, CREATE2 collision resistance, initializer guard, EIP-712 chain-replay safety. Write `work/x402-agent-payment/audit-security.md`.
- **Skill:** security-auditor
- **Reviewers:** none

#### Task 15: Test Audit
- **Description:** Full-feature test quality audit. Verify ≥85% middleware line coverage, ≥95% contract branch coverage. Verify ajv schema check on 402 body, EIP-712 tamper tests, settlement taxonomy coverage, forked-e2e adequacy. Write `work/x402-agent-payment/audit-tests.md`.
- **Skill:** test-master
- **Reviewers:** none

### Final Wave

#### Task 16: Pre-deploy QA (requires user approval of tech-spec)
- **Description:** Verify user has approved the tech-spec (`status: approved` in frontmatter). Block if still `draft`. Run full test suite: `npm test` + `cd contracts && npx hardhat test && npx hardhat coverage` + `ARC_TESTNET_E2E=1 npm run test:e2e --workspace=packages/middleware`. Walk every AC in user-spec and tech-spec's Acceptance Criteria. Produce checklist report. Block deploy if any AC unmet.
- **Skill:** pre-deploy-qa
- **Reviewers:** none

#### Task 17: Deploy to Arc Testnet + npm publish (alpha)
- **Description:** `01_deploy_factory.ts --network arcTestnet`. Verify on `https://testnet.arcscan.app`. Commit updated `networks.ts` with addresses. Publish `@universal-paywall/middleware@0.1.0-alpha.0` with `--access=public --tag=alpha --provenance` (SLSA build provenance).
- **Skill:** deploy-pipeline
- **Reviewers:** none
- **Verify-smoke:** `npm view @universal-paywall/middleware@0.1.0-alpha.0 dist.tarball` returns a tarball URL.

#### Task 18: Post-deploy verification
- **Description:** Live environment verification on Arc Testnet:
  - On-chain: `factory.feeBps() == 50`; `factory.platformTreasury()` matches deploy config; `factory.owner()` matches expected multisig (or deployer for MVP). — tool: bash + viem script.
  - Run live e2e test against the published factory: `ARC_TESTNET_E2E=1 npm run test:e2e`. — tool: bash.
  - HTTP smoke in a scratch dir: install `@universal-paywall/middleware@0.1.0-alpha.0`, set up a Node server, hit with curl, verify 402 body is x402 v1-shaped (ajv-validated). — tool: bash + curl.
  Tools: bash, curl, viem (programmatic, not MCP).
- **Skill:** post-deploy-qa
- **Reviewers:** none
