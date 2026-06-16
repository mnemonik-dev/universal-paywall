---
feature: x402-agent-payment
created: 2026-06-16
status: draft
size: L
branch: dev
---

# Tech Spec: x402 Payment Flow for AI Agents

## Solution

Reimplement the original tech-spec for full compliance with the **x402 v1 specification** (Coinbase / Circle / Foundation). Three components ship together:

1. **`@universal-paywall/middleware`** — TypeScript npm package. Acts as both server (returns 402, gates resource) and **self-hosted x402 facilitator** (verifies EIP-712 typed-data signatures off-chain, settles `transferWithAuthorization` on-chain via a relayer wallet that pays gas in USDC). Framework-agnostic core with thin adapters for Node http and Fastify.
2. **`PaymentSplitter.sol`** (Arc Testnet, Solidity 0.8.20+, OpenZeppelin `Ownable` / `Pausable` / `ReentrancyGuard`). Custom function `payWithAuthorization(developerId, value, validAfter, validBefore, nonce, v, r, s)` that wraps `USDC.transferWithAuthorization(...)` and accounts per developer + platform fee in a single on-chain transaction.
3. **Deploy + tooling** — Hardhat config with Arc Testnet network, deploy script, developer-onboarding CLI (`scripts/register.ts`), README.

**Why this redesign:** The previous tech-spec used EIP-2612 permit + agent-submits-tx + custom header schema. None of that matches the x402 standard — clients (CDP `x402` SDK, Circle SDK) would not interoperate. The standard uses EIP-3009 `transferWithAuthorization` + signed-off-chain-authorization + facilitator-settled-on-chain + standardized JSON wire format. This rewrite aligns end-to-end with the spec verified against `github.com/coinbase/x402` and `docs.cdp.coinbase.com/x402/`.

**Chain choice:** Arc Testnet only for MVP. Arc Mainnet is unreleased by Circle as of 2026-06. `arc-mainnet` is left as a `NETWORKS` registry entry placeholder gated by feature flag (filled when Circle ships).

## Architecture

### What we're building

- **`packages/middleware/`** — npm package `@universal-paywall/middleware`
- **`contracts/`** — Hardhat project, single `PaymentSplitter.sol` contract
- **`scripts/register.ts`** — CLI to invoke `splitter.register(wallet)` from a local key

```
packages/middleware/src/
  index.ts             # public exports: withPaywall, fastifyPaywall, NETWORKS, types
  core.ts              # paywall(req, opts) — pure facilitator pipeline (framework-agnostic)
  adapters/
    node-http.ts       # withPaywall(handler, opts): (req, res) => Promise<void>
    fastify.ts         # fastifyPaywall(opts): FastifyPluginAsync
  x402.ts              # build402Body, encodeXPaymentResponse, decodeXPayment
  verify.ts            # verifyEip3009Authorization (viem recoverTypedDataAddress)
  settle.ts            # settleOnChain — call splitter.payWithAuthorization via WalletClient
  replay-store.ts      # NonceStore: Set with validBefore-TTL eviction
  networks.ts          # NETWORKS map: arc-testnet (mainnet placeholder)
  errors.ts            # buildErrorResponse(reason): typed 402 responses
  types.ts             # PaymentRequirements, PaymentPayload, FacilitatorConfig
  __tests__/

contracts/
  contracts/
    PaymentSplitter.sol
    interfaces/
      IPaymentSplitter.sol
      IERC3009.sol
  test/PaymentSplitter.test.ts
  deploy/01_deploy_splitter.ts
  hardhat.config.ts
  package.json

scripts/
  register.ts
```

### How it works

Sequence (happy path):

```
1.  Agent → GET /api/data        (no X-PAYMENT header)
2.  Middleware adapter normalizes req → core.paywall(req, opts)
3.  core: no header → build402Body() with PaymentRequirements pointing at
                splitterAddress for current network, asset=USDC system contract,
                value=parseUnits(price, 6), extra.assetTransferMethod="eip3009"
        → return { status: 402, headers: {content-type: application/json}, body }
4.  Adapter writes 402 response

5.  Agent signs EIP-712 TransferWithAuthorization off-chain (no broadcast)
        domain:  {name:"USDC", version:"2", chainId, verifyingContract: usdc}
        types:   TransferWithAuthorization
        message: {from, to: splitter, value, validAfter, validBefore, nonce}
6.  Agent → GET /api/data
        X-PAYMENT: base64(JSON({x402Version:1, scheme:"exact", network, payload:{
          signature, authorization, developerId
        }}))

7.  core.paywall(req, opts):
    a.  decodeXPayment(header) → PaymentPayload (or 400 if malformed)
    b.  verifyEip3009Authorization:
          - recover address from signature against
            domain {chainId from NETWORKS[network], verifyingContract: usdc}
          - check recovered == authorization.from
          - check authorization.to == NETWORKS[network].splitterAddress
          - check authorization.value >= maxAmountRequired
          - check validBefore > now + safetyMargin (default 5s)
          - check validAfter <= now
          - check payload.network === opts.network (cross-network guard)
          - check replayStore.has({from, nonce}) === false; insert
    c.  settleOnChain:
          - splitter.payWithAuthorization(
              developerId, value, validAfter, validBefore, nonce, v, r, s
            ) via WalletClient signed by relayerKey
          - await getTransactionReceipt
          - if revert → buildErrorResponse('settlement_failed', revertReason)
          - else → tx hash
    d.  set X-PAYMENT-RESPONSE: base64(JSON({success:true, transaction, network, payer:from}))
    e.  return { passthrough: true, responseHeaders }

8.  Adapter calls user's handler with responseHeaders pre-set
9.  User handler runs, returns 200 + resource
```

### Shared resources

| Resource | Owner (creates) | Consumers | Instance count |
|----------|----------------|-----------|----------------|
| viem `PublicClient` (Arc RPC reader) | `core.ts` (lazy-init per `network` config) | `verify.ts`, `settle.ts` | 1 per network in use within a process |
| viem `WalletClient` with relayer signer | `core.ts` (lazy-init per `network` + `relayerKey`) | `settle.ts` | 1 per network in use within a process |
| `NonceStore` (in-memory `Map<from, Set<nonce>>` with TTL) | `core.ts` (process-singleton) | `verify.ts` | 1 per process (NOT shared across instances — see Risks) |
| `NETWORKS` registry | `networks.ts` (module-level const) | all middleware modules, deploy scripts | 1 (compile-time) |

## Decisions

### D1: Adopt standard x402 v1 wire format

**Decision:** 402 response body is JSON per `x402Version: 1` with `accepts[]` of `PaymentRequirements`. `X-PAYMENT` header is base64-encoded JSON `{x402Version, scheme, network, payload}`. `X-PAYMENT-RESPONSE` is base64 JSON `{success, transaction, network, payer}`.
**Rationale:** Supports user-spec "любой x402 v1-совместимый клиент работает" (Middleware AC). Verified against `github.com/coinbase/x402/specs/schemes/exact/scheme_exact_evm.md`.
**Alternatives considered:** Custom `PAYMENT-REQUIRED` header (prior tech-spec) — rejected, breaks interop with every existing x402 client SDK.

### D2: EIP-3009 `transferWithAuthorization` over EIP-2612 permit

**Decision:** Use EIP-3009 typed-data signing for off-chain authorization. Splitter wraps `USDC.transferWithAuthorization`.
**Rationale:** Supports user-spec Middleware AC "EIP-712 ecrecover + on-chain settle". This is the only signature standard accepted by the x402 `exact` scheme on EVM (`extra.assetTransferMethod: "eip3009"`). Circle USDC implements EIP-3009 natively.
**Alternatives considered:**
- EIP-2612 permit: rejected — not part of x402 spec, would require non-standard client.
- Permit2 (Uniswap): supported by spec as fallback but adds dependency on Permit2 proxy; not needed when USDC has native EIP-3009.

### D3: Self-hosted facilitator inline in middleware (not external service)

**Decision:** Middleware itself holds a relayer private key (`PAYWALL_RELAYER_KEY` env var) and submits the settle transaction. No separate facilitator service.
**Rationale:** Supports user-spec "Запустить middleware с relayer-ключом" + project.md positions middleware as the developer-facing single deploy. Inline keeps the architecture simple (~150 LoC of facilitator code vs running a Rust binary like `x402-rs`).
**Alternatives considered:**
- CDP facilitator: rejected — Arc Network is not in CDP's supported networks list.
- Self-host `x402-rs` (Rust): rejected — adds new toolchain, requires custom scheme to call our splitter instead of USDC directly.
- Fork `x402-rs`: rejected — Rust maintenance burden disproportionate to the inline TS code we'd save.

### D4: Custom splitter wraps `transferWithAuthorization` (non-custodial split)

**Decision:** `splitter.payWithAuthorization(developerId, ...args)` internally calls `USDC.transferWithAuthorization(from, splitter, value, ...)`, then accounts `developers[developerId].balance += value - fee` and `platformBalance += fee`.
**Rationale:** Supports user-spec "non-custodial split". USDC arrives at splitter and is immediately attributed to the developer in a single tx. No platform custody window. Anyone (relayer) can submit because EIP-3009 signature is verified at USDC layer, not against `msg.sender`.
**Alternatives considered:**
- `payTo = developer wallet` direct (no splitter): rejected — loses on-chain platform fee.
- Off-chain accounting + treasury splitter: rejected — becomes custodial-lite, contradicts user-spec.

### D5: Open registration, gated withdrawal

**Decision:** `register(wallet)` accepts any caller; the registered address is only used as a key, not authenticated against `msg.sender`. `withdraw(amount)` checks `msg.sender` is registered and has sufficient balance.
**Rationale:** [TECHNICAL] Simpler onboarding — registration is "opt-in claim", withdrawal is wallet-gated. A malicious actor pre-registering someone else's wallet only enables payments to that wallet, not theft. Matches the documented model in `patterns.md`.
**Alternatives considered:** `require(msg.sender == wallet)` on `register` — adds friction (e.g., onboarding from a hardware wallet via delegation) without security benefit. Deferred.

### D6: Two-layer replay protection

**Decision:**
- On-chain: USDC's built-in `authorizationState[from][nonce]` (part of EIP-3009).
- API-level: in-memory `NonceStore` in middleware tracking `(from, nonce)` pairs with TTL eviction when `validBefore` passes.

**Rationale:** Supports user-spec AC "Повторный (from, nonce) → 402 nonce_already_used". The original tech-spec used a `usedTxSigs` mapping in the contract keyed on tx hash — which is impossible (EVM contracts cannot read their own enclosing tx hash). The new model is sound: USDC stops the same authorization being settled twice on-chain; middleware NonceStore stops a single valid X-PAYMENT being replayed to many API responses.
**Alternatives considered:** Server-issued nonce/challenge bound into 402 response — adds round-trip cost and server-side state. Deferred.

### D7: Framework-agnostic core + thin per-framework adapters

**Decision:** `core.ts` exposes `paywall(req, opts)` taking a minimal `{headers, method, url}` shape. Two adapters in `adapters/`: `node-http.ts` (`withPaywall(handler)`) and `fastify.ts` (`fastifyPaywall(opts)`). Next.js / Hono / Bun adapters post-MVP.
**Rationale:** Supports user-spec AC "exports withPaywall and fastifyPaywall". The original AC "framework-agnostic `(req, res) => Promise<void>`" is internally contradictory (that signature is Node http, not framework-agnostic). This decomposition gets us both.
**Alternatives considered:** Single Node-http signature — rejected; doesn't fit Fastify hook model cleanly, hurts adoption.

### D8: viem for all EVM interaction

**Decision:** Use `viem` 2.x for: EIP-712 ecrecover (`recoverTypedDataAddress`), USDC contract reads (`getContract`), splitter contract write (`writeContract` via `WalletClient`), receipt awaiting.
**Rationale:** [TECHNICAL] `viem` is in `architecture.md` dependencies and is TypeScript-native, tree-shakable, no class instances. Pure-function style fits middleware design.
**Alternatives considered:** ethers.js — bulkier, class-based, slower. Rejected.

### D9: Solidity 0.8.20+, OpenZeppelin 5.x

**Decision:** Pragma `^0.8.20`. Use `@openzeppelin/contracts` 5.x for `Ownable`, `Pausable`, `ReentrancyGuard`, `IERC20`.
**Rationale:** [TECHNICAL] OZ 5.x requires ≥0.8.20. Modern Solidity ships safer defaults (custom errors, transient storage for `nonReentrant`).
**Alternatives considered:** OZ 4.x — older patterns, manual ownership transfer. Rejected.

### D10: Hardhat over Foundry

**Decision:** Hardhat for tests + deploy.
**Rationale:** [TECHNICAL] `architecture.md` lists Hardhat. JS-native tooling consistent with the rest of the monorepo. Fork-based local dev via `hardhat_reset`.
**Alternatives considered:** Foundry — faster tests, but adds Rust toolchain and a second test framework.

### D11: Configurable platform fee — owner-only, 0–10% range, default 50 bps

**Decision:** `setFee(uint16 bps)` revert if `bps > 1000`. Default 50 bps set in constructor. `PlatformFeeUpdated(uint16 oldBps, uint16 newBps)` event.
**Rationale:** Supports user-spec AC "setFee доступен только owner; максимум 1000 bps". Matches `patterns.md`. Configurable allows platform to A/B fee. Cap prevents owner griefing developers.

### D12: `withdrawPlatformFees(address to)` — destination as parameter

**Decision:** Owner specifies a destination address per withdrawal, not a hard-coded treasury.
**Rationale:** [TECHNICAL] Decouples `owner` (a multisig admin role) from the platform treasury (`PLATFORM_WALLET_ADDRESS` in `deployment.md`). Resolves the prior contradiction.

### D13: `Pausable` — block payments, allow withdrawals

**Decision:** When `paused()`: `payWithAuthorization` reverts; `register`, `withdraw`, `withdrawAll`, `withdrawPlatformFees` continue to work.
**Rationale:** [TECHNICAL] Emergency stop for incident response (e.g. discovered vulnerability) without locking developers out of their accumulated USDC. Standard money-handling pattern.

## Data Models

### Contract storage

```solidity
struct Developer {
    bool registered;
    uint256 balance;        // micro-USDC owed to this developer
    uint64 registeredAt;    // block timestamp (informational)
}

mapping(address => Developer) public developers;
uint256 public platformBalance;   // micro-USDC owed to platform
uint16 public feeBps;             // 0..1000
IERC20 public immutable usdc;     // set in constructor
```

Events:
```solidity
event DeveloperRegistered(address indexed wallet);
event PaymentReceived(
    address indexed developerId,
    address indexed payer,
    uint256 value,
    uint256 platformFee
);
event Withdrawal(address indexed wallet, uint256 amount);
event PlatformFeesWithdrawn(address indexed to, uint256 amount);
event PlatformFeeUpdated(uint16 oldBps, uint16 newBps);
```

### Middleware types (TypeScript)

```ts
export interface NetworkConfig {
  id: 'arc-testnet' | 'arc-mainnet';
  chainId: number;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  splitterAddress: `0x${string}`;
  caip2: string; // "eip155:5042002" etc.
}

export interface PaywallConfig {
  price: string;          // USD-denominated, e.g. '0.01'
  developerId: `0x${string}`;
  network?: 'arc-testnet' | 'arc-mainnet'; // default arc-testnet
  facilitator: {
    mode: 'inline';
    relayerKey: `0x${string}`;
    rpcUrl?: string;       // override NETWORKS[network].rpcUrl
  };
  resource?: string;       // override `req.url` in 402 body
  description?: string;
}

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  asset: `0x${string}`;
  extra: { assetTransferMethod: 'eip3009'; name: string; version: string };
}

export interface ExactEvmPayload {
  signature: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  developerId: `0x${string}`;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  payload: ExactEvmPayload;
}
```

## Dependencies

### New packages (middleware)
- `viem` — EVM RPC, EIP-712 typed-data ecrecover, contract calls.
- `vitest` — unit tests (matches Vite-friendly stack).
- `tsup` — TS bundling for npm package.

### New packages (contracts)
- `@openzeppelin/contracts` 5.x — `Ownable`, `Pausable`, `ReentrancyGuard`, `IERC20`.
- `hardhat`, `@nomicfoundation/hardhat-toolbox`, `@nomicfoundation/hardhat-verify` — toolchain.
- `hardhat-deploy` (optional) — deterministic deploy script (rejected if confuses Hardhat Ignition workflow; deploy as plain script for MVP).

### Reused from project
- TypeScript, ESLint, Prettier from monorepo root.
- gitleaks pre-commit (matches `patterns.md`).

## Testing Strategy

**Feature size:** L — three-tier coverage required.

### Unit tests (vitest, in `packages/middleware/`)
- x402 codec: 402 body builder produces spec-compliant JSON; X-PAYMENT decoder handles malformed/missing fields; X-PAYMENT-RESPONSE encoder.
- `verify.ts`: valid signature passes; tampered signature fails; cross-domain signature (wrong chainId) fails; wrong `to` fails; `value < required` fails; `validBefore <= now` fails; `validAfter > now` fails.
- `replay-store.ts`: same `(from, nonce)` rejected; entries evict after `validBefore` passes; concurrent writes safe.
- `errors.ts`: each `error` reason produces canonical body shape.
- `core.ts`: missing header path returns 402; happy path orchestrates verify + settle in order; settle failure returns 402; network mismatch returns 402.
- Price parsing: `'0.01'` → `10000n`; `'1.5'` → `1500000n`; `'0.000001'` → `1n`; reject `'1.2345678'` (too many decimals) and `'abc'`.

### Contract tests (Hardhat + chai, target 100% branch coverage)
- `register`: idempotent; emits event.
- `payWithAuthorization`: happy path mints to developer + platform; unregistered dev reverts; insufficient signature value reverts (via USDC); reentrancy guard (mock token that reenters).
- `withdraw` / `withdrawAll`: happy path; over-withdraw reverts; reentrancy guard; respects paused/unpaused for `withdraw`.
- `setFee`: owner-only; `bps > 1000` reverts; event emitted.
- `withdrawPlatformFees`: owner-only; transfers correct amount; event emitted.
- `pause`/`unpause`: owner-only; `payWithAuthorization` reverts when paused; `withdraw` works when paused.

### Integration test (Hardhat + Arc Testnet)
- End-to-end against deployed splitter on Arc Testnet:
  - Spawn a real HTTP server with `withPaywall()` wrapping a stub handler.
  - Hand-crafted EIP-3009 signer (using viem locally) produces a valid X-PAYMENT.
  - Hit the endpoint twice: first call returns 402; second call (with X-PAYMENT) settles on-chain and returns 200.
  - Assert: developer balance in contract increased by `value - fee`, platform balance by `fee`, replay store rejects a third call with the same nonce.

### Acceptance tests via pre-deploy-qa
- All user-spec acceptance criteria verified by `pre-deploy-qa` skill in Final Wave.

## Agent Verification Plan

**Source:** user-spec sections "Критерии приёмки" and "Флоу".

### Verification approach
- Per-task `Verify-smoke` checks (specified in each task below): unit-test commands, hardhat compile/test, integration test, deploy dry-run.
- After Wave 5 the agent will spin up a local Hardhat node forking Arc Testnet and run the integration test from Wave 5 task.
- Final Wave QA re-runs every test suite and walks through all 19+ AC items from user-spec + this tech-spec.

### Tools required
- bash + curl (for direct HTTP smoke on the local server).
- Hardhat CLI (for contract deploy + Arc Testnet RPC reads).
- Optional: Playwright MCP — not used in MVP (no browser surface). Telegram MCP — not used.
- viem (programmatic) — used inside the integration test, not as an MCP tool.

## Risks

| Risk | Mitigation |
|------|-----------|
| Arc Testnet USDC doesn't expose `transferWithAuthorization` as expected. | Wave 2 first task verifies on a live Arc Testnet read: call `versionString()` / `DOMAIN_SEPARATOR()` on `0x3600...` and decode. If absent, switch chain to Base Sepolia (similar USDC). |
| Relayer wallet exhausts USDC gas mid-settle (Arc gas paid in USDC). | Pre-deploy QA verifies relayer has ≥ 1 USDC balance. Document monitoring requirement in README. Out of scope: auto-refill. |
| `NonceStore` is per-process — replay protection breaks under horizontal scaling. | Document: MVP supports single-process middleware. Multi-instance support (Redis-backed store) deferred to post-MVP. AC for Wave 4 includes a comment in `replay-store.ts` flagging this. |
| Arc Testnet RPC instability or rate limit. | `NETWORKS.arc-testnet.rpcUrl` overridable via `facilitator.rpcUrl`. Fallback mirror `https://5042002.rpc.thirdweb.com` documented in README. |
| EIP-712 chain replay attack (same signature valid on a different chain with same USDC name/version). | EIP-712 domain includes `chainId` and `verifyingContract`. As long as agent client sets `chainId` correctly, signature is chain-bound. Test asserts this. |
| Owner key compromise → fee maxed, platform fees drained. | Document recommendation: use a multisig (e.g. Safe) as `initialOwner` at deploy time. Not enforced in contract. |
| Contract verifier on `arcscan.app` differs in flow from Etherscan. | Deploy script uses `hardhat-verify` and falls back to manual upload of source via the explorer UI. Documented in README. |

## User-Spec Deviations

All deviations were resolved by rewriting user-spec in lockstep with this tech-spec. The current user-spec (revision dated 2026-06-16) is fully consistent with this tech-spec.

- **Original user-spec used `pay(developerId, amount, txSig)` and custom `PAYMENT-REQUIRED` header** — both replaced. user-spec was rewritten to specify `payWithAuthorization(developerId, value, validAfter, validBefore, nonce, v, r, s)` and the standard x402 JSON body in 402 response. Documented here for traceability of the change. → User-spec already updated; flagged for re-approval together with tech-spec.
- **MVP scope reduced from Arc Mainnet to Arc Testnet only** — Arc Mainnet is not yet released by Circle. Same change applied to user-spec. → User-spec already updated.
- **Added `Pausable` + emergency stop semantics** — not in original user-spec. Justification: standard money-handling safety. → user-spec ACs added in rewrite.
- **Added `withdrawPlatformFees(address to)` with destination parameter** — original AC said owner-only without destination. → user-spec updated to specify parameter.
- **Replay protection split between on-chain (USDC nonce) + middleware (NonceStore)** — original said "in contract via `usedTxSigs`" which was unimplementable. → user-spec updated to specify both layers.
- **Wallet rotation explicitly out of scope** — was implicit before. → user-spec "Что не входит" updated.

→ **[PENDING USER APPROVAL]** — entire user-spec + tech-spec set, post-rewrite.

## Acceptance Criteria

Technical AC complementing user-spec:

- [ ] `npm install && npm run build --workspace=packages/middleware` succeeds; output is a valid npm package (ESM + types).
- [ ] `cd contracts && npx hardhat compile` succeeds without warnings.
- [ ] `cd contracts && npx hardhat test` passes with ≥95% branch coverage on `PaymentSplitter.sol`.
- [ ] `npm test --workspace=packages/middleware` passes; coverage report shows ≥80% line coverage on `src/`.
- [ ] Integration test against Arc Testnet passes when `ARC_TESTNET_E2E=1` env var is set.
- [ ] Deploy script outputs deployed splitter address; address is verifiable on `https://testnet.arcscan.app`.
- [ ] No secrets (relayer key, owner key) committed; gitleaks pre-commit blocks commits with key patterns.
- [ ] Middleware bundle size <30 KB minified+gzip (excluding `viem`).
- [ ] `packages/middleware/package.json` declares `engines.node: ">=20"` and exports map for ESM + CJS.

## Implementation Tasks

### Wave 1 — Project setup (parallel)

#### Task 1: Monorepo scaffolding
- **Description:** Initialize npm workspace root with `packages/middleware`, `contracts`, `scripts` workspaces. Set up TypeScript strict mode, ESLint, Prettier, gitleaks pre-commit hook. Configure `packages/middleware/package.json` (name `@universal-paywall/middleware`, exports map, `tsup` build script, `engines.node: ">=20"`).
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `npm install && npm run lint && npm run build --workspace=packages/middleware`
- **Files to modify:** `package.json`, `packages/middleware/package.json`, `packages/middleware/tsconfig.json`, `packages/middleware/tsup.config.ts`, `.eslintrc.cjs`, `.prettierrc`, `.husky/pre-commit`
- **Files to read:** `.gitignore`, `CLAUDE.md`, `.claude/skills/project-knowledge/references/patterns.md`

#### Task 2: Hardhat project setup
- **Description:** Initialize Hardhat TypeScript project in `contracts/`. Configure Arc Testnet network in `hardhat.config.ts` (chainId 5042002, RPC, accounts from env). Add `@openzeppelin/contracts@^5.0.0`, `@nomicfoundation/hardhat-toolbox`, `@nomicfoundation/hardhat-verify`. Pin Solidity to `^0.8.20`. Smoke `npx hardhat compile` on an empty `Lock.sol` placeholder.
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat compile && npx hardhat help`
- **Files to modify:** `contracts/hardhat.config.ts`, `contracts/package.json`, `contracts/tsconfig.json`
- **Files to read:** `package.json`, `.claude/skills/project-knowledge/references/architecture.md`

#### Task 3: Verify Arc Testnet USDC supports EIP-3009 (spike)
- **Description:** Write a small Hardhat script that connects to Arc Testnet RPC and reads the USDC contract at `0x3600000000000000000000000000000000000000`: confirm it exposes `transferWithAuthorization`, read EIP-712 domain (`name()`, `version()`, `DOMAIN_SEPARATOR()`, `chainId`). Goal: de-risk the assumption in D2 before writing the splitter. If the function is missing — surface to user and decide on chain switch.
- **Skill:** code-writing
- **Reviewers:** code-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat run scripts/verify-usdc.ts --network arcTestnet` outputs `{name: "USDC", version: "2", supportsEip3009: true}`
- **Files to modify:** `contracts/scripts/verify-usdc.ts`
- **Files to read:** `contracts/hardhat.config.ts`

### Wave 2 — Smart contract (sequential, after Wave 1)

#### Task 4: PaymentSplitter.sol implementation
- **Description:** Implement `PaymentSplitter` (Solidity 0.8.20+) with: `constructor(IERC20 usdc, address initialOwner, uint16 initialFeeBps)`, `register(address wallet)` (idempotent, emits `DeveloperRegistered`), `payWithAuthorization(address developerId, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` (calls `IERC3009(usdc).transferWithAuthorization(...)` internally with `from = ecrecover_inside_USDC`, accounts split, emits `PaymentReceived`), `withdraw(uint256 amount)`, `withdrawAll()`, `getBalance(address developer)`, `setFee(uint16 bps)` (max 1000, owner-only, emits `PlatformFeeUpdated`), `withdrawPlatformFees(address to)` (owner-only, emits `PlatformFeesWithdrawn`), `pause()`/`unpause()` (owner-only). Inherits `Ownable`, `Pausable`, `ReentrancyGuard`. Define `IPaymentSplitter` interface and `IERC3009` partial interface.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat compile`
- **Files to modify:** `contracts/contracts/PaymentSplitter.sol`, `contracts/contracts/interfaces/IPaymentSplitter.sol`, `contracts/contracts/interfaces/IERC3009.sol`
- **Files to read:** `contracts/hardhat.config.ts`, `.claude/skills/project-knowledge/references/patterns.md`, `work/x402-agent-payment/user-spec.md`

#### Task 5: Contract unit tests
- **Description:** Hardhat + chai tests covering every branch of `PaymentSplitter.sol` (≥95% branch coverage). Mock USDC with an EIP-3009 implementation. Cover: register idempotent, payWithAuthorization happy path + insufficient value + unregistered dev + reentrancy attempt, withdraw happy + over-withdraw + reentrancy, setFee cap + owner-only, withdrawPlatformFees, pause/unpause behavior with allowed vs blocked functions, all events.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat test && npx hardhat coverage`
- **Files to modify:** `contracts/test/PaymentSplitter.test.ts`, `contracts/test/mocks/MockUsdcEip3009.sol`
- **Files to read:** `contracts/contracts/PaymentSplitter.sol`

### Wave 3 — Middleware core (parallel, after Wave 1)

#### Task 6: NETWORKS registry + types
- **Description:** Build `networks.ts` exporting `NETWORKS` map with `arc-testnet` entry (chainId 5042002, RPC `https://rpc.testnet.arc.network`, USDC `0x3600000000000000000000000000000000000000`, splitterAddress as `0x0` placeholder filled by deploy script later, caip2 `eip155:5042002`). Include `arc-mainnet` entry guarded by `enabled: false` flag. Define and export all TypeScript types: `NetworkConfig`, `PaywallConfig`, `PaymentRequirements`, `ExactEvmPayload`, `PaymentPayload`.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `packages/middleware/src/networks.ts`, `packages/middleware/src/types.ts`
- **Files to read:** `work/x402-agent-payment/code-research.md`

#### Task 7: x402 wire-format codec
- **Description:** Implement `x402.ts` with: `build402Body(config, req)` returning x402 v1 JSON `{x402Version, accepts: [PaymentRequirements]}`; `decodeXPayment(headerValue)` parsing base64+JSON and validating shape (throws structured `X402DecodeError` for missing/invalid fields); `encodeXPaymentResponse({success, transaction, network, payer})` returning base64 string. Pure functions, no I/O.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `packages/middleware/src/x402.ts`
- **Files to read:** `packages/middleware/src/types.ts`, `packages/middleware/src/networks.ts`

#### Task 8: Error response builders
- **Description:** Implement `errors.ts` with one builder per spec'd `error` reason: `invalid_signature`, `insufficient_amount`, `authorization_expired`, `nonce_already_used`, `network_mismatch`, `developer_not_registered`, `settlement_failed`, `malformed_payment_header`. Each returns an HTTP 402 response shape `{ status: 402, headers: { 'content-type': 'application/json' }, body: { x402Version: 1, accepts: [PaymentRequirements], error: string, ...details } }`.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `packages/middleware/src/errors.ts`
- **Files to read:** `packages/middleware/src/x402.ts`, `packages/middleware/src/types.ts`

### Wave 4 — Middleware facilitator + adapters (parallel, after Waves 2+3)

#### Task 9: Verify (off-chain signature)
- **Description:** Implement `verify.ts` exporting `verifyEip3009Authorization(payload, ctx)`. Uses `viem.recoverTypedDataAddress` with domain `{name: NETWORKS[network].usdc-name, version: '2', chainId, verifyingContract: usdc}`. Validates: recovered == `authorization.from`, `to == splitterAddress`, `value >= maxAmountRequired`, `validBefore > now + 5s`, `validAfter <= now`, network match, replay-store miss. Returns `{ok: true}` or `{ok: false, error}`.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `packages/middleware/src/verify.ts`
- **Files to read:** `packages/middleware/src/x402.ts`, `packages/middleware/src/networks.ts`, `packages/middleware/src/replay-store.ts`

#### Task 10: Replay store + Settle (on-chain submit)
- **Description:** Implement `replay-store.ts` (`NonceStore` class: `has({from, nonce})`, `insert({from, nonce, validBefore})`, periodic eviction via lazy check on insert). Implement `settle.ts` exporting `settleOnChain(payload, ctx, walletClient)`: builds a `splitter.payWithAuthorization(developerId, value, validAfter, validBefore, nonce, v, r, s)` calldata, sends via `WalletClient`, awaits receipt, returns `{ok: true, txHash}` or `{ok: false, reason}` (decodes revert reason if available).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `packages/middleware/src/replay-store.ts`, `packages/middleware/src/settle.ts`
- **Files to read:** `packages/middleware/src/verify.ts`, `packages/middleware/src/networks.ts`, `contracts/contracts/interfaces/IPaymentSplitter.sol`

#### Task 11: Core paywall pipeline + adapters
- **Description:** Implement `core.ts` exporting `paywall(req, opts) -> Promise<PaywallResult>` that orchestrates: missing header → 402; decode → verify → settle → 200-passthrough with response headers; any failure → 402 with appropriate error builder. Implement `adapters/node-http.ts` exporting `withPaywall(handler, opts)` returning Node http `(req, res) => Promise<void>`. Implement `adapters/fastify.ts` exporting `fastifyPaywall(opts)` returning a Fastify plugin. Export everything from `index.ts`.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Files to modify:** `packages/middleware/src/core.ts`, `packages/middleware/src/adapters/node-http.ts`, `packages/middleware/src/adapters/fastify.ts`, `packages/middleware/src/index.ts`
- **Files to read:** `packages/middleware/src/x402.ts`, `packages/middleware/src/verify.ts`, `packages/middleware/src/settle.ts`, `packages/middleware/src/errors.ts`

### Wave 5 — Tests + tooling (parallel, after Wave 4)

#### Task 12: Middleware unit tests
- **Description:** Vitest suite covering all middleware modules per "Unit tests" in Testing Strategy. Mock viem RPC and WalletClient. Test price parsing edge cases. Include a test asserting that the 402 body matches x402 spec verbatim (snapshot or schema check against the known canonical fields).
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=packages/middleware -- --coverage`
- **Files to modify:** `packages/middleware/__tests__/*.test.ts`
- **Files to read:** all files in `packages/middleware/src/`

#### Task 13: Deploy script + registration CLI + README
- **Description:** Hardhat deploy script `contracts/deploy/01_deploy_splitter.ts`: deploys `PaymentSplitter(usdcAddress, deployerAddress, 50)`, calls `hardhat-verify` against arcscan, prints deployed address. Patches `packages/middleware/src/networks.ts` with the deployed `splitterAddress`. Build `scripts/register.ts` — minimal CLI (`tsx`) that takes `--wallet`, `--network`, reads a key from `REGISTER_KEY` env, calls `splitter.register(wallet)`. Write `README.md` documenting: get faucet USDC → run `register` → install middleware → configure withPaywall → run server.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx hardhat run deploy/01_deploy_splitter.ts --network arcTestnet` outputs an address
- **Verify-user:** Read `README.md` and confirm the steps would work if followed by a new developer.
- **Files to modify:** `contracts/deploy/01_deploy_splitter.ts`, `scripts/register.ts`, `README.md`, `packages/middleware/src/networks.ts`
- **Files to read:** `contracts/contracts/PaymentSplitter.sol`, `contracts/hardhat.config.ts`

#### Task 14: End-to-end integration test on Arc Testnet
- **Description:** A vitest integration test gated by `ARC_TESTNET_E2E=1`. Starts a local Node http server using `withPaywall()`. Constructs a real EIP-3009 signature with viem against deployed splitter. Sends request without header → asserts 402 body matches schema. Sends request with header → asserts 200 + X-PAYMENT-RESPONSE present + on-chain `splitter.getBalance(developerId)` increased by `value - fee` and `platformBalance` by `fee`. Sends a third request with the same nonce → asserts 402 `nonce_already_used`.
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `ARC_TESTNET_E2E=1 npm run test:e2e --workspace=packages/middleware`
- **Files to modify:** `packages/middleware/__tests__/integration/e2e.test.ts`
- **Files to read:** `packages/middleware/src/index.ts`, `contracts/contracts/PaymentSplitter.sol`

### Audit Wave (parallel, after Wave 5)

#### Task 15: Code Audit
- **Description:** Full-feature code quality audit. Read every source file in `packages/middleware/src/`, `contracts/contracts/`, `scripts/`, `contracts/deploy/`. Review holistically: shared resources compliance, framework-adapter consistency, naming, error handling. Write `work/x402-agent-payment/audit-code.md`.
- **Skill:** code-reviewing
- **Reviewers:** none

#### Task 16: Security Audit
- **Description:** Full-feature security audit. OWASP Top 10 across the middleware (input validation on X-PAYMENT, secrets handling for relayer key, RPC URL trust, integer overflow in price/fee math). Solidity-focused review of `PaymentSplitter.sol`: reentrancy, integer overflow, access control on each function, event emissions, pause-flow correctness, gas griefing vectors, EIP-712 chain-replay safety. Write `work/x402-agent-payment/audit-security.md`.
- **Skill:** security-auditor
- **Reviewers:** none

#### Task 17: Test Audit
- **Description:** Full-feature test quality audit. Verify middleware unit-test coverage ≥80%, contract branch coverage ≥95%, integration test asserts both success and replay-rejection paths. Verify meaningful assertions (not just truthy checks), mock realism, no slept-on flakiness. Write `work/x402-agent-payment/audit-tests.md`.
- **Skill:** test-master
- **Reviewers:** none

### Final Wave

#### Task 18: Pre-deploy QA
- **Description:** Run full test suite (`npm test` at root + `cd contracts && npx hardhat test` + integration test with `ARC_TESTNET_E2E=1`). Walk through every acceptance criterion in user-spec (`Middleware`, `PaymentSplitter контракт`, `Деплой и тестирование` sections) and in this tech-spec's Acceptance Criteria. Produce a checklist report. Block deploy if any AC unmet.
- **Skill:** pre-deploy-qa
- **Reviewers:** none

#### Task 19: Deploy to Arc Testnet + npm publish (alpha)
- **Description:** Run `01_deploy_splitter.ts --network arcTestnet`. Verify contract on `https://testnet.arcscan.app`. Update `packages/middleware/src/networks.ts` with deployed splitter address; commit. Publish `@universal-paywall/middleware@0.1.0-alpha.0` to npm with `--access=public --tag=alpha`.
- **Skill:** deploy-pipeline
- **Reviewers:** none
- **Verify-smoke:** `npm view @universal-paywall/middleware@0.1.0-alpha.0 dist.tarball` returns a tarball URL.

#### Task 20: Post-deploy verification
- **Description:** Live environment verification on Arc Testnet:
  - On-chain read: `splitter.feeBps()` returns 50; `splitter.owner()` returns the multisig (or deployer for MVP). — tool: bash + viem script.
  - Run integration test against the published splitter address. — tool: bash.
  - HTTP smoke: install `@universal-paywall/middleware@0.1.0-alpha.0` in a scratch dir, set up a Node server with `withPaywall()`, hit it with curl, verify the 402 body is x402 v1-shaped. — tool: bash + curl.
  Tools: bash, curl, viem (programmatic, not MCP).
- **Skill:** post-deploy-qa
- **Reviewers:** none
