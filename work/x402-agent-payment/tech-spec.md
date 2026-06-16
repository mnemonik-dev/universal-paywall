---
feature: x402-agent-payment
status: draft
created: 2026-06-16
size: L
branch: dev
---

# Tech Spec: x402 Payment Flow for AI Agents

## Overview

Three-component implementation: a TypeScript middleware npm package (`@universal-paywall/middleware`), a Solidity `PaymentSplitter` smart contract deployed on Arc Network, and Hardhat deploy scripts with a local Arc Testnet fork for development. The payment mechanism uses EIP-2612 permit for single-transaction USDC payments from AI agents to the splitter contract.

## Architecture

### Components

**`packages/middleware/`** — npm package `@universal-paywall/middleware`

```
src/
  index.ts          # Public API: withPaywall(), PaywallConfig
  x402.ts           # 402 response builder, PAYMENT-REQUIRED header encoder
  verify.ts         # X-Payment header parser, Arc RPC tx verification via viem
  networks.ts       # Chain config: Arc Testnet / Mainnet RPC URLs + contract addresses
  errors.ts         # Structured error response builders
```

**`contracts/`** — Hardhat project

```
contracts/
  PaymentSplitter.sol   # Main contract
  interfaces/
    IPaymentSplitter.sol
test/
  PaymentSplitter.test.ts
deploy/
  01_deploy_splitter.ts
hardhat.config.ts
```

**`packages/middleware/src/networks.ts`** — chain registry (baked into package):

```ts
export const NETWORKS = {
  'arc-testnet': {
    rpcUrl: 'https://rpc.testnet.arc.network',
    chainId: 5042002,
    usdcAddress: '0x3600000000000000000000000000000000000000',
    splitterAddress: '0x...',  // filled after testnet deploy
  },
  'arc-mainnet': {
    rpcUrl: 'https://rpc.arc.network',
    chainId: 60808,
    usdcAddress: '0x...',     // Arc mainnet USDC
    splitterAddress: '0x...',  // filled after mainnet deploy
  },
}
```

### Data Flow

```
1. withPaywall(handler, { price, developerId, network? }) → WrappedHandler

2. Incoming request → WrappedHandler:
   a. No X-Payment header?
      → Build PAYMENT-REQUIRED:
          { asset: "USDC", network, amount: priceToMicroUsdc(price),
            payTo: NETWORKS[network].splitterAddress, developerId }
      → HTTP 402, header: PAYMENT-REQUIRED: base64(JSON)

   b. X-Payment header present?
      → Decode base64: { tx_hash, network }
      → viem.getTransactionReceipt(tx_hash) on Arc RPC
      → Verify: tx to == splitterAddress
      → Verify: tx input decodes to payWithPermit(developerId, amount >= required, ...)
      → Verify: tx status == "success"
      → Pass to handler → HTTP 200
      → Set PAYMENT-RESPONSE: base64({ success: true, tx_hash, amount })
```

### Payment Transaction Flow (EIP-2612 Permit)

Agent submits one transaction to Arc Network:

```
PaymentSplitter.payWithPermit(
  developerId: address,
  amount:      uint256,    // micro-USDC (6 decimals)
  deadline:    uint256,    // EIP-2612 permit deadline
  v, r, s:     bytes       // EIP-712 permit signature from agent wallet
)
```

Contract internally:
1. `USDC.permit(agent, splitter, amount, deadline, v, r, s)` — approve via signature
2. `USDC.transferFrom(agent, splitter, amount)` — pull USDC
3. `platformFee = amount * fee / 10000`
4. `developers[developerId].balance += amount - platformFee`
5. `platformBalance += platformFee`
6. `usedTxSigs[txHash] = true` — replay guard

### Shared Resources

| Resource | Owner | Consumers |
|---|---|---|
| Arc RPC client (viem PublicClient) | Created per `withPaywall()` call | `verify.ts` |
| NETWORKS config | `networks.ts` (compile-time) | `x402.ts`, `verify.ts` |

No long-lived shared state in middleware — it's a pure function wrapper.

## Decisions

**D1: EIP-2612 Permit over approve+transferFrom** — Supports US-3 (agent pays with single call). Agent signs permit offchain (no gas), submits one `payWithPermit()` tx. Reduces agent tx count from 2 to 1. Requires Arc USDC to support EIP-2612 (Circle USDC does).

**D2: tx_hash as payment proof (not offchain signature)** — Supports US-3, US-5 (verifiable payment). Agent submits onchain tx first, then passes tx_hash in X-Payment. Middleware verifies via `getTransactionReceipt()`. Simpler than offchain signature settlement — no Circle Gateway dependency, no custodial batch processing.

**D3: Middleware verifies receipt (not pending tx)** — [TECHNICAL] `getTransactionReceipt()` returns null for pending txs. Middleware returns 402 with `reason: "tx_pending"` if receipt not yet available. Agent should wait for tx confirmation before retry. Prevents double-spend on pending txs.

**D4: Platform fee configurable (owner-only, max 10%)** — Supports US-2 (platform monetization). `setFee(bps)` restricted to contract owner. Cap at 1000 bps (10%) hardcoded as safety guard. Default: 50 bps (0.5%). Deviates from patterns.md which says "hardcoded" — see User-Spec Deviations.

**D5: Hardhat over Foundry** — [TECHNICAL] architecture.md lists Hardhat; Foundry is faster for testing but adds new toolchain. Hardhat chosen for ecosystem consistency. Arc Testnet fork via `hardhat_fork` for local dev.

**D6: viem over ethers.js** — [TECHNICAL] `viem` already in architecture.md dependencies. Lighter, TypeScript-native, no class instances — fits pure-function middleware design.

**D7: One shared contract for all developers** — Supports US-1 (developer registers once). Developer calls `register(wallet)` on shared contract. No per-developer contract deployment. Simpler onboarding, single audit surface.

**D8: Pull model for developer withdrawals** — Supports US-1 (developer receives funds). No auto-push on every payment (gas expensive at scale). Developer calls `withdraw(amount)` when needed. Platform fees also pulled via `withdrawPlatformFees()` by owner.

## Implementation Tasks

### Wave 1 — Project Setup (parallel)

**T1: Monorepo scaffolding**
Initialize npm workspace root with `packages/middleware` and `contracts` workspaces. Set up TypeScript (tsconfig), ESLint, Prettier, and gitleaks pre-commit hook. Configure `packages/middleware/package.json` with correct name `@universal-paywall/middleware`, exports map, and build script (tsc).
- Skill: `infrastructure-setup`
- Reviewers: `code-reviewer`
- Files to create: `package.json`, `packages/middleware/package.json`, `packages/middleware/tsconfig.json`, `.eslintrc`, `.prettierrc`

**T2: Hardhat project setup**
Initialize Hardhat TypeScript project in `contracts/`. Configure Arc Testnet and Arc Mainnet networks in `hardhat.config.ts`. Add `@openzeppelin/contracts`, `viem`, `hardhat-toolbox` dependencies. Set up local Arc Testnet fork task.
- Skill: `infrastructure-setup`
- Reviewers: `code-reviewer`
- Files to create: `contracts/hardhat.config.ts`, `contracts/package.json`
- Verify-smoke: `cd contracts && npx hardhat compile`

### Wave 2 — Smart Contract (sequential)

**T3: PaymentSplitter.sol**
Implement the PaymentSplitter contract with: `register(wallet)`, `payWithPermit(developerId, amount, deadline, v, r, s)`, `withdraw(amount)`, `withdrawAll()`, `setFee(bps)`, `withdrawPlatformFees()`, `getBalance(developer)`. Include EIP-2612 permit flow, replay guard via `usedTxSigs`, and owner-only fee management. Emit events: `PaymentReceived`, `DeveloperRegistered`, `Withdrawal`.
- Skill: `code-writing`
- Reviewers: `code-reviewer`, `security-auditor`
- Files to create: `contracts/contracts/PaymentSplitter.sol`, `contracts/contracts/interfaces/IPaymentSplitter.sol`

**T4: Contract unit tests**
Write Hardhat tests covering: register (idempotent), payWithPermit (happy path, insufficient amount, wrong developerId, replay), withdraw (happy path, excess amount), setFee (owner only, cap enforcement), getBalance. Run on local Arc Testnet fork. Achieve 100% branch coverage on PaymentSplitter.sol.
- Skill: `test-master`
- Reviewers: `code-reviewer`
- Files to create: `contracts/test/PaymentSplitter.test.ts`
- Verify-smoke: `cd contracts && npx hardhat test`

### Wave 3 — Middleware (parallel)

**T5: withPaywall() core + 402 builder**
Implement `withPaywall(handler, config)` in `packages/middleware/src/index.ts`. On missing X-Payment header: encode PAYMENT-REQUIRED JSON (asset, network, amount in micro-USDC, payTo, developerId), base64-encode, return HTTP 402. Price string `"$0.01"` → micro-USDC conversion. Export `PaywallConfig` TypeScript type.
- Skill: `code-writing`
- Reviewers: `code-reviewer`
- Files to create: `packages/middleware/src/index.ts`, `packages/middleware/src/x402.ts`, `packages/middleware/src/networks.ts`

**T6: X-Payment verification**
Implement `verify.ts`: decode base64 X-Payment header, call `viem.getTransactionReceipt(tx_hash)` on Arc RPC, verify tx recipient == splitterAddress, decode tx input to confirm `payWithPermit(developerId, amount >= required, ...)`, check receipt status == "success". Return structured result: `{ valid: true }` or `{ valid: false, reason: string }`.
- Skill: `code-writing`
- Reviewers: `code-reviewer`, `security-auditor`
- Files to create: `packages/middleware/src/verify.ts`

**T7: Error handling + structured responses**
Implement `errors.ts` with typed 402 error response builders for each failure case: `payment_required`, `tx_not_found`, `tx_pending`, `insufficient_amount`, `tx_already_used`, `developer_not_registered`, `payment_failed`. All return `{ error, reason, required?, received?, tx_hash? }`.
- Skill: `code-writing`
- Reviewers: `code-reviewer`
- Files to create: `packages/middleware/src/errors.ts`

### Wave 4 — Integration & Deploy (parallel)

**T8: Middleware unit tests**
Write unit tests for: 402 response format (correct base64 encoding, all required fields), X-Payment parsing (valid/invalid base64, missing fields), price-to-micro-USDC conversion edge cases, each error response type. Mock viem RPC calls. Run via `npm test` in `packages/middleware`.
- Skill: `test-master`
- Reviewers: `code-reviewer`
- Files to create: `packages/middleware/src/__tests__/`

**T9: Deploy scripts + README**
Write Hardhat deploy script `contracts/deploy/01_deploy_splitter.ts`: deploy PaymentSplitter with correct USDC address per network, verify on block explorer. After deploy: update `packages/middleware/src/networks.ts` with deployed addresses. Write README covering: Arc Testnet faucet link, `register(wallet)` call, middleware install + config, running local tests.
- Skill: `code-writing`
- Reviewers: `code-reviewer`
- Files to create: `contracts/deploy/01_deploy_splitter.ts`, `README.md`
- Verify-smoke: `cd contracts && npx hardhat run deploy/01_deploy_splitter.ts --network arcTestnet`

### Wave 5 — Integration Test

**T10: End-to-end integration test on Arc Testnet**
Write an integration test that uses GatewayClient (from `@circle-fin/x402-batching`) to make a real payment against a test endpoint protected by `withPaywall()`. Test runs against Arc Testnet: agent wallet funded with test USDC, developer wallet registered in deployed contract, middleware verifies payment via Arc Testnet RPC. Assert: HTTP 200 received, developer balance in contract increased.
- Skill: `test-master`
- Reviewers: `code-reviewer`
- Files to create: `packages/middleware/src/__tests__/integration/e2e.test.ts`
- Verify-smoke: `ARC_TESTNET=1 npm run test:integration`

### Audit Wave (parallel)

**T11: Code Audit**
Holistic code quality review of all feature code: middleware TypeScript, Solidity contract, deploy scripts, tests.
- Skill: `code-reviewing`
- Reviewers: none

**T12: Security Audit**
OWASP review with smart contract focus: reentrancy in withdraw(), integer overflow in fee calculation, permit signature replay, griefing via malformed tx_hash, input validation in middleware.
- Skill: `security-auditor`
- Reviewers: none

**T13: Test Audit**
Coverage and quality review: contract branch coverage, middleware unit test completeness, integration test reliability on Testnet.
- Skill: `test-master`
- Reviewers: none

### Final Wave

**T14: QA**
Run full test suite (`npm test` + `cd contracts && npx hardhat test`). Verify all 19 acceptance criteria from user-spec. Manual check: `withPaywall()` with real Express server + GatewayClient on Arc Testnet.
- Skill: `pre-deploy-qa`
- Reviewers: none
- Verify-user: Test agent payment end-to-end on Arc Testnet, confirm developer balance updates in contract.

**T15: Deploy to Arc Testnet**
Deploy PaymentSplitter to Arc Testnet, verify on block explorer, update `networks.ts` with deployed address, publish `@universal-paywall/middleware@0.1.0-testnet` to npm.
- Skill: `deploy-pipeline`
- Reviewers: none
- Verify-smoke: `curl https://rpc.testnet.arc.network -d '{"method":"eth_call","params":[{"to":"<splitter>","data":"0x..."}]}'`

## User-Spec Deviations

**DEV-1: Platform fee configurable** ✅ Resolved
- patterns.md updated: fee is configurable via `setFee(bps)`, default 50 bps, cap 1000 bps.

**DEV-2: Chain-agnostic design, Arc as first chain** ✅ Resolved
- architecture.md updated: blockchain layer is EVM chain-agnostic. Arc Network is first supported chain. Base and Ethereum mainnet are post-MVP. `networks.ts` in middleware is the single registry — adding a new chain = one entry, no contract rewrite needed.

None pending user approval.

## Testing Strategy

**Size: L** — Full three-tier test coverage required.

| Tier | Scope | Tooling |
|---|---|---|
| Unit | Middleware functions, error builders, price conversion | Vitest / Jest |
| Contract | PaymentSplitter all branches, 100% coverage | Hardhat + chai |
| Integration | Real GatewayClient → Arc Testnet → middleware verify | Node test runner, Arc Testnet |

Security pre-requisite: contract security audit (T12) must pass before mainnet deploy.
