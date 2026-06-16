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

### D15: Vault implementation contract is locked from direct initialization

**Decision:** `PaymentVaultImpl` constructor calls `_disableInitializers()` (OZ 5.x `Initializable` helper). The implementation contract therefore cannot be `initialize`-d directly — only clones produced by the factory can be initialized once each.
**Rationale:** Cloneable contracts that don't disable initializers on the impl let any external actor seize the impl by calling `initialize` first. While the impl is never the `payTo` address (only clones are), a hijacked impl can be used in social-engineering / supply-chain attacks. Standard OZ guidance. [TECHNICAL] — security-driven, not in user-spec.
**Alternatives considered:** Set a dummy initializer in the impl constructor — equivalent. `_disableInitializers()` is the canonical primitive.

### D16: Vault has no `receive()` or `fallback()` payable

**Decision:** `PaymentVaultImpl` defines neither `receive() external payable` nor `fallback() external payable`. Native asset (ETH-equivalent) sent to the vault reverts. The only on-chain inbound path is ERC-20 `transfer` of the configured USDC token.
**Rationale:** USDC is the native gas token on Arc Network — there is no separate ETH-equivalent that vaults should accept. Refusing native sends prevents accidental loss and keeps the vault's invariant simple (`balanceOf(this)` is the only quantity that matters). [TECHNICAL] — captures the user-spec constraint as a Decision.

### D17: Vault `developer` and `factory` are set once in `initialize` and have no setters

**Decision:** `PaymentVaultImpl` stores `developer` and `factory` as plain `address` fields written exactly once inside `initialize(_developer)`. No `setDeveloper`, no `setFactory`, no migration helpers. The `Initializable` guard prevents re-initialization. Documented in code via NatSpec; enforced structurally by the absence of setters.
**Rationale:** Vault funds belong to one developer and rely on one factory for fee/treasury reads. Allowing either to change after initialization would let a compromised factory or migration script reroute developer funds. [TECHNICAL] — captures the user-spec constraint as a Decision.
**Alternatives considered:** "Logical" immutables via `private` storage + view getters — equivalent. `immutable` keyword cannot be used on values written in `initialize` (Solidity requires constructor-set), so the field is functionally immutable in practice but typed as plain `address`.

### D18: Structured security logging surface

**Decision:** Middleware accepts an optional `logger: SecurityLogger` field in `PaywallConfig` (defaults to no-op). `SecurityLogger` is an interface with `securityEvent(name, payload)` where `name ∈ {'signature_invalid', 'nonce_replay_attempt', 'settlement_failed', 'paused_request', 'vault_not_deployed', 'network_mismatch', 'header_too_large', 'malformed_header', 'relayer_initialized', 'chain_id_pinned'}`. Payloads pass through the relayer-key redactor.
**Rationale:** OWASP A09 (Security Logging & Monitoring Failures). Without a logger surface, operators have no audit trail for forensic incident response. Default-no-op keeps it optional; integrators wire `pino`/`winston`/Datadog as needed. [TECHNICAL] — security-driven.

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

**Decision:** Introduce `OpaqueRelayerKey` type whose private field is non-enumerable + `toJSON()` returns redacted string + `toString()` redacts + `[util.inspect.custom]` symbol returns redacted (so `console.log(config)` does NOT print the key) + the wrapper survives `pino`/`winston` log serialization without leaking. `settle.ts` is the only consumer that extracts the underlying key (via a private symbol). All error handling redacts unknown stack content matching `0x[0-9a-fA-F]{64}`. The same wrapper is used for `REGISTER_KEY` in `scripts/register.ts`.
**Rationale:** Mitigates accidental leak via `console.log(config)`, `JSON.stringify(config)`, `util.inspect(config)`, error stack capture, and structured loggers. [TECHNICAL] — not in user-spec, security-driven.

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
address public developer;     // set in initialize, never overwritten — no setter exists (D17)
address public factory;       // set in initialize, never overwritten — no setter exists (D17)
// Initializable's internal _initialized flag enforces single-call (D15 + D17)

// No receive() or fallback() — native asset transfers revert (D16)

event Withdrawal(address indexed developer, uint256 gross, uint256 fee);

constructor() {
    _disableInitializers();   // D15: lock the impl from direct initialize
}
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
- `relayer-key.ts`: `JSON.stringify` redacts; `toString` redacts; `util.inspect` redacts (custom `[util.inspect.custom]` symbol); `structuredClone` does not expose the secret; the wrapper survives `pino`/`winston` log serialization without leaking; error stacks redact 0x[a-f0-9]{64} patterns; field is non-enumerable.
- D14 startup chainId pin: middleware constructed with a mismatched RPC vs `NETWORKS[id].chainId` throws `NetworkMismatchError` on first request; correctly matched chainId is a no-op.
- D18 SecurityLogger surface: each of the 10 event names emits when its trigger condition is met; payloads pass through the same redactor; default no-op logger produces no output.
- Factory-state cache (paused / vaults): TTL 5s; a fresh registration is invisible until cache expiry; RPC error during cache fill returns the last good value if non-stale, else propagates as `settlement_failed.reason = "rpc_5xx"`.
- Adapter unit tests (separate from forked-e2e):
  - `withPaywall` (Node http) propagates handler exceptions; sets response headers correctly; flushes before user handler is invoked.
  - `fastifyPaywall` (Fastify plugin) integrates into Fastify lifecycle (`preHandler`); sends 402 reply when X-PAYMENT absent; preserves Fastify reply chaining on 200.
- `errors.ts`: each error reason produces a canonical body matching the schema.
- Price parsing: `'0.01'` → `10000n`; `'1.5'` → `1500000n`; reject `'1.2345678'`, `'abc'`, `''`, `'-1'`, `'0'`, `'1e2'`, `' 1 '`.

### Contract tests (Hardhat + chai, ≥95% branch coverage)
- `PaymentSplitterFactory.test.ts`:
  - `register`: deploys vault at predicted address; `vaults[developer]` populated; idempotent re-call reverts `AlreadyRegistered`; paused → reverts `EnforcedPause` (OZ 5.x); vault `initialize` called once with `_developer = msg.sender`.
  - **CREATE2 cross-component invariant**: off-chain compute (middleware-side helper that mirrors `Clones.predictDeterministicAddress`) returns the same address as on-chain `computeVaultAddress`. Assert exact byte equality for at least 3 distinct developer EOAs.
  - **`register` reentrancy invariant**: a malicious developer EOA whose `initialize` callback re-enters `factory.register()` is blocked (via OZ's `ReentrancyGuard` or check-before-effect ordering). Even though `initialize` on a fresh impl shouldn't normally callback, pin the invariant for future refactors.
  - `setFeeBps`: owner-only; revert `InvalidFeeBps` on `bps > 1000`; emits.
  - `setPlatformTreasury`: owner-only; revert `ZeroAddress`; emits.
  - `Ownable2Step` two-step transfer happy path + cancel.
  - `pause`/`unpause`: owner-only.
  - Constructor reverts on zero usdc/treasury/feeBps > 1000.
  - **`VaultDeployed` event**: arg matches predicted address; `vaults[unregistered]` returns `0x0`; two separate developers in the same block produce two distinct vault addresses.
- `PaymentVaultImpl.test.ts` (via clone deployed in test fixture):
  - `initialize` is single-call; reverts on second call.
  - **`_disableInitializers()` on impl** (D15): calling `initialize` directly on `vaultImpl` (not a clone) reverts. This is the canonical hijack vector for cloneable contracts; explicit test.
  - **No `receive()` / `fallback()`** (D16): sending native asset to the vault reverts.
  - **No setters for `developer` / `factory`** (D17): pattern-test the ABI to assert neither selector exists (`setDeveloper(address)`, `setFactory(address)`).
  - `withdraw`: developer-only; no-balance reverts `NoBalance`; happy path splits gross→developer/fee→treasury; emits `Withdrawal(developer, gross, fee)`.
  - Fee edge cases: `feeBps = 0` → `fee = 0`, no second transfer; `feeBps = 1000` → 10% fee; `gross = 1` micro-USDC → `fee = 0` (truncation), full 1 unit to developer.
  - **Fee-snapshot semantics**: factory.setFeeBps invoked between two payments and one withdraw — assert withdraw uses the fee at withdraw time (current contract semantics; documented behavior).
  - Reentrancy: malicious treasury that re-enters `withdraw` is blocked by `ReentrancyGuard`.
  - Withdraw works when factory is `paused()` (developers not locked out).
- Forked-integration: `forked-e2e.test.ts` (runs in CI, no env gate) — deploys mock USDC with EIP-3009 + factory + vault + middleware (in-process Node http server AND Fastify server), runs the full happy path against BOTH adapters and the replay-rejection path against one, asserts: 200 received, vault USDC balance increased by `value`, NonceStore rejects same-nonce retry, on-chain `usdc.authorizationState(from, nonce)` is true after settle. Also asserts rejection branches: `vault_not_deployed` (developer never registered) and `paused` (factory paused mid-test).

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
| Relayer wallet exhausts USDC mid-settle (Arc gas paid in USDC). | Pre-deploy QA verifies relayer USDC ≥ 1. **Detection logic** in `settle.ts`: before `writeContract`, read `USDC.balanceOf(relayer)`; if `< gasEstimate * 2` → return `settlement_failed.reason = "relayer_no_balance"` (proactive). If `writeContract` still fails on gas — re-classify reactively under the same reason. Both paths emit `securityEvent("settlement_failed")`. README documents operational monitoring. Auto-refill is out of MVP scope. |
| Per-payment settlement creates per-event gas overhead; high-volume API (sustained > 1 req/s) sees a non-trivial fraction of payment value spent on gas. | Documented limitation: MVP per-payment is fine for low/mid-volume. **Wave 1 Task 3 spike measures real `transferWithAuthorization` gas cost on Arc Testnet**. If gas > 5% of a 0.01 USDC payment, surface to user and consider deferring high-volume paths to a separate `x402-batched-settlement` feature (post-MVP, Gateway-pattern). |
| Owner-key compromise reroutes treasury or maxes fee instantly (no timelock). | `Ownable2Step` prevents accidental loss; **does NOT prevent intentional reroute by a compromised key**. Mitigation: deployment guide (`deployment.md`) requires multisig (Safe) as initial owner; multisig provides social timelock. Add `timelock_recommended_for_treasury_changes` to README operational guide. **Optional post-MVP**: replace `Ownable2Step` with `TimelockController`. |
| `paused()` is read off-chain with a 5s TTL cache; in-flight settlements between pause and cache expiry still settle on-chain. | Documented: pause is "stop new payments" not "freeze the contract". Withdrawals are unaffected (intentional). Operationally: pause has at most a 5s latency window. For instant on-chain freeze, owner can deploy a new factory and redirect middleware NETWORKS config (chain-agnostic by design). |
| Front-running of `setFeeBps` / `setPlatformTreasury` against pending `vault.withdraw`. | Fee/treasury reads at withdraw time → owner changing these can affect withdraws in the same block. Treated as "fee schedule" not "fixed contract" semantics. Documented in README. Multisig owner reduces risk of malicious change. |
| Untrusted RPC could fabricate settlement success (lie about receipt). | D14 chainId pin protects against accidental wrong-chain RPC. Against an **adversarial** RPC, the only defense is RPC URL trust at deploy. Documented: `facilitator.rpcUrl` must be a trusted endpoint. Optional post-MVP: cross-verify receipt against a second RPC. |
| Rogue clone deployment (deploying a contract that LOOKS like a vault but isn't from the factory). | `payTo` in 402 is computed by middleware via `factory.computeVaultAddress(developerEoa)` against the canonical factory address baked into `NETWORKS[id].factoryAddress`. An agent following the 402 body always pays the correct vault. A vault that wasn't deployed by the canonical factory will have `factory != NETWORKS[id].factoryAddress` and middleware skips it. **`PaymentVaultImpl.initialize` is called by the factory at clone time**, so `factory = msg.sender = canonical factory` by construction (no need for runtime back-pointer check; the immutability constraint D17 guarantees this can't change). |
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
- **No partial-withdraw API on vault (`withdraw()` only, no `withdraw(amount)`).** [TECHNICAL — D4] Justification: partial withdrawals enable fee-rounding gaming (small `amount` where `amount * feeBps / 10000 == 0` skips fee entirely). Single full-balance withdraw makes fee math exact. User-facing impact: developers cannot leave a portion accruing in the vault; if a developer wants to "save up", they must wait between withdraws.
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

## Acceptance Criteria (technical complement)

Technical AC complementing user-spec ACs:

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

#### Task 3: Verify Arc Testnet USDC supports EIP-3009 + measure gas (spike)
- **Description:** Hardhat script that hits Arc Testnet RPC, confirms USDC `0x3600…` exposes `transferWithAuthorization` (selector **`0xe3ee160e`**) + `authorizationState(address,bytes32)`. Reads `name()`, `version()`, `decimals()`. **Also estimates gas for a sample `transferWithAuthorization` call** and converts to USDC cost — surfaces to user if cost > 5% of a 0.01 USDC payment (per-payment economics check from external-analysis.md). Patches `NETWORKS.arc-testnet.usdcEip712Name/version` with the values read.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat run scripts/verify-usdc-eip3009.ts --network arcTestnet` prints `{name, version, decimals: 6, supportsEip3009: true, sampleGasCost: "<n> micro-USDC"}`
- **Files to modify:** `contracts/scripts/verify-usdc-eip3009.ts`
- **Files to read:** `contracts/hardhat.config.ts`, `packages/middleware/src/networks.ts`

### Wave 2 — Smart contracts (after Wave 1)

#### Task 4: Factory + Vault contracts
- **Description:** Implement `PaymentSplitterFactory` and `PaymentVaultImpl` per Decisions D3/D4/D8/D10–D17 and Data Models. Define `IERC3009` interface and `MockUsdcEip3009` for tests. (Contract method/event signatures live in Data Models — implement to spec.)
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat compile`
- **Files to modify:** `contracts/contracts/{PaymentSplitterFactory.sol, PaymentVaultImpl.sol, interfaces/IERC3009.sol, mocks/MockUsdcEip3009.sol}`
- **Files to read:** `work/x402-agent-payment/user-spec.md`, `work/x402-agent-payment/tech-spec.md`

### Wave 3 — Contract tests (after Wave 2)

#### Task 5: Contract tests
- **Description:** Hardhat + chai tests per Testing Strategy → "Contract tests" (covers CREATE2 cross-component invariant, `_disableInitializers()` impl-hijack guard, no-`receive()`/no-setter ABI assertions, fee math, withdraw-while-paused, `Ownable2Step`, register reentrancy invariant, all events). ≥95% branch coverage.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat coverage`
- **Files to modify:** `contracts/test/{PaymentSplitterFactory.test.ts, PaymentVaultImpl.test.ts}`
- **Files to read:** `contracts/contracts/PaymentSplitterFactory.sol`, `contracts/contracts/PaymentVaultImpl.sol`

### Wave 4 — Middleware pure modules (parallel, after Wave 1)

#### Task 6: Types, NETWORKS, x402 codec, errors, relayer-key, replay-store
- **Description:** All pure modules in one task (no external I/O, no inter-dependencies beyond `types.ts`): `networks.ts` (NETWORKS keyed by both alias `arc-testnet` and CAIP-2 `eip155:5042002`, name/version stubbed for Task 3 patch); `types.ts` (per Data Models); `x402.ts` (build/decode/encode with 4 KB cap + strict shape); `errors.ts` (HTTP 400 vs 402 per Solution); `relayer-key.ts` (OpaqueRelayerKey with `[util.inspect.custom]`, redacted `toJSON`/`toString`, symbol-based extract); `replay-store.ts` (NonceStore sync has+insert, TTL, 100k cap).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- src/__tests__/{x402,errors,networks,relayer-key,replay-store}.test.ts`
- **Files to modify:** `packages/middleware/src/{networks.ts,types.ts,x402.ts,errors.ts,relayer-key.ts,replay-store.ts}`
- **Files to read:** `work/x402-agent-payment/code-research.md`, `work/x402-agent-payment/user-spec.md`

### Wave 5 — Middleware facilitator (parallel, after Waves 3+4)

#### Task 7: Verify + Settle
- **Description:** `verify.ts` (EIP-712 ecrecover + Solution-7c checks; classifies error reasons). `settle.ts` (WalletClient.writeContract to USDC.transferWithAuthorization with explicit `from`; receipt-await with timeout; classifier maps failures to the 7 settlement reasons per D5; chainId pin per D14).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- src/__tests__/{verify,settle}.test.ts`
- **Files to modify:** `packages/middleware/src/{verify.ts,settle.ts}`
- **Files to read:** `packages/middleware/src/{x402.ts,networks.ts,replay-store.ts,relayer-key.ts}`, `contracts/contracts/interfaces/IERC3009.sol`

#### Task 8: Core orchestrator + adapters + index
- **Description:** `core.ts` orchestrates verify + factory-state cache + settle + response per Solution. `adapters/node-http.ts` and `adapters/fastify.ts` (per D6). `index.ts` exports public API. SecurityLogger surface from D18 wired through.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm run build --workspace=packages/middleware && node -e "import('@universal-paywall/middleware').then(m=>console.log(Object.keys(m).sort()))"`
- **Files to modify:** `packages/middleware/src/{core.ts,adapters/node-http.ts,adapters/fastify.ts,index.ts}`
- **Files to read:** `packages/middleware/src/{verify.ts,settle.ts,errors.ts,x402.ts}`

### Wave 6 — Tests + tooling (parallel, after Wave 5)

#### Task 9: Middleware unit tests (incl. adapter unit tests)
- **Description:** Vitest per Testing Strategy → "Unit tests" + the dedicated adapter tests (Node http and Fastify lifecycle). ajv-validates 402 body against vendored x402 v1 schema. Factory-state cache TTL + RPC-error tests. ≥85% line coverage.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- --coverage`
- **Files to modify:** `packages/middleware/__tests__/*.test.ts`, `packages/middleware/__tests__/fixtures/x402-v1.schema.json`
- **Files to read:** all of `packages/middleware/src/`

#### Task 10: Forked integration + Arc Testnet e2e (gated)
- **Description:** Forked test exercises both adapters end-to-end against mock USDC + factory + vault, including rejection branches (`vault_not_deployed`, `paused`) and on-chain `usdc.authorizationState(from, nonce)` assertion. Live Arc Testnet test (`ARC_TESTNET_E2E=1`, nightly) for production-environment confidence.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat test test/integration/forked-e2e.test.ts`
- **Files to modify:** `contracts/test/integration/forked-e2e.test.ts`, `packages/middleware/__tests__/integration/arc-testnet-e2e.test.ts`
- **Files to read:** `packages/middleware/src/index.ts`, `contracts/contracts/PaymentSplitterFactory.sol`, `contracts/contracts/PaymentVaultImpl.sol`

#### Task 11: Deploy script + register CLI + README
- **Description:** Deploy script for factory + impl; arcscan verification; patches `networks.ts` with deployed addresses. `register.ts` CLI invokes `factory.register()` from developer EOA. README walks: faucet → register → install middleware → run server.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** Dry-run on local Hardhat node: `cd contracts && npx hardhat node` (separate terminal) + `npx hardhat run deploy/01_deploy_factory.ts --network localhost`
- **Verify-user:** Read `README.md`; the steps work when followed by a new developer.
- **Files to modify:** `contracts/deploy/01_deploy_factory.ts`, `scripts/register.ts`, `README.md`, `packages/middleware/src/networks.ts`
- **Files to read:** `contracts/contracts/PaymentSplitterFactory.sol`, `contracts/hardhat.config.ts`

### Audit Wave (parallel, after Wave 6)

#### Task 12: Code Audit
- **Description:** Holistic full-feature code quality audit across `packages/middleware/src/`, `contracts/contracts/`, `scripts/`, `contracts/deploy/`, `contracts/scripts/`. Write `work/x402-agent-payment/audit-code.md`.
- **Skill:** code-reviewing
- **Reviewers:** none

#### Task 13: Security Audit
- **Description:** OWASP middleware + Solidity audit covering reentrancy, access control, event emissions, Pausable correctness, CREATE2 collision, initializer guard, EIP-712 chain-replay, OpaqueRelayerKey defense-in-depth. Write `work/x402-agent-payment/audit-security.md`.
- **Skill:** security-auditor
- **Reviewers:** none

#### Task 14: Test Audit
- **Description:** Verify coverage targets; ajv schema check, EIP-712 tamper tests, settlement taxonomy, CREATE2 cross-component test, `_disableInitializers()` test, adapter unit tests, forked-e2e completeness. Write `work/x402-agent-payment/audit-tests.md`.
- **Skill:** test-master
- **Reviewers:** none

### Final Wave

#### Task 15: Pre-deploy QA (requires user approval of tech-spec)
- **Description:** Block if `status: draft`. Run full suites: `npm test` + `cd contracts && npx hardhat test && npx hardhat coverage` + `ARC_TESTNET_E2E=1 npm run test:e2e --workspace=packages/middleware`. Walk every user-spec and tech-spec AC. Produce checklist report.
- **Skill:** pre-deploy-qa
- **Reviewers:** none
- **Verify-smoke:** All suites exit 0; checklist report committed under `work/x402-agent-payment/qa-report.md`.

#### Task 16: Deploy to Arc Testnet + npm publish (alpha)
- **Description:** Deploy factory; verify on arcscan. Commit `networks.ts` with addresses. Publish `@universal-paywall/middleware@0.1.0-alpha.0` with `--access=public --tag=alpha --provenance`.
- **Skill:** deploy-pipeline
- **Reviewers:** code-reviewer, security-auditor, deploy-reviewer
- **Verify-smoke:** `npm view @universal-paywall/middleware@0.1.0-alpha.0 dist.tarball` returns a tarball URL.

#### Task 17: Post-deploy verification
- **Description:** Live environment verification:
  - On-chain reads: `factory.feeBps() == 50`, `factory.platformTreasury()` matches deploy, `factory.owner()` is expected multisig/deployer, `factory.paused() == false`. — tool: bash + viem script.
  - Live e2e against the deployed factory: `ARC_TESTNET_E2E=1 npm run test:e2e`. — tool: bash.
  - HTTP smoke: install `@universal-paywall/middleware@0.1.0-alpha.0` in a scratch dir, run a Node server, curl returns ajv-valid 402 body. — tool: bash + curl.
  Tools: bash, curl, viem (programmatic, not MCP).
- **Skill:** post-deploy-qa
- **Reviewers:** none
- **Verify-smoke:** All three steps return success; verification report committed under `work/x402-agent-payment/post-deploy-report.md`.
