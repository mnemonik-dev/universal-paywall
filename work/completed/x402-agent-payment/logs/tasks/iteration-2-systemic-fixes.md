# Iteration 2 — Systemic Fixes (binding decisions for all task-creators)

These decisions are authoritative for fix-mode iteration 2. Every task-creator MUST honour these when rewriting their task file.

## 1. Wave renumbering (strict: depends_on tasks must be in strictly earlier wave)

| Task | Wave | depends_on |
|---|---|---|
| T1 — Monorepo scaffolding | 1 | [] |
| T2 — Hardhat setup | 1 | [] |
| T3 — USDC spike + gas measurement | 2 | [2] |
| T4 — Factory + Vault contracts | 3 | [1, 2] (NO T3 — independent) |
| T5 — Contract tests | 4 | [4] |
| T6 — Middleware pure modules | 5 | [1, 3] (T3 adds JSON-artifact handoff) |
| T7 — Verify + Settle | 6 | [4, 6] |
| T8 — Core orchestrator + adapters | 7 | [6, 7] |
| T9 — Middleware unit tests | 8 | [6, 7, 8] |
| T11 — Deploy + register + README | 8 | [4, 8] |
| T10 — Forked + Arc Testnet e2e | 9 | [5, 8, 9] |
| T12 — Code Audit | 10 | [9, 10, 11] |
| T13 — Security Audit | 10 | [9, 10, 11] |
| T14 — Test Audit | 10 | [9, 10, 11] |
| T15 — Pre-deploy QA | 11 | [12, 13, 14] |
| T16 — Deploy + npm publish | 12 | [15] |
| T17 — Post-deploy verification | 13 | [16] |

T9 and T11 are parallel in Wave 8; T9 owns the x402 schema fixture, T10 consumes it (so T10 lands one wave later).

## 2. Test directory canonicalization

All vitest test files live under `packages/middleware/src/__tests__/`. Single tree. The vendored x402 schema fixture lives at `packages/middleware/src/__tests__/fixtures/x402-v1.schema.json`. **NOT** `packages/middleware/__tests__/`. Update T6, T7, T9, T10, and any task that references the path.

Tech-spec section "What we're building" already shows `__tests__/` under `src/`; T9 was the outlier.

## 3. Canonical environment variable names

From `deployment.md`:

| Variable | Used by | Default |
|---|---|---|
| `ARC_RPC_URL` | T2, T3, T6, T11 — Arc Testnet RPC | `https://rpc.testnet.arc.network` |
| `DEPLOYER_KEY` | T2 (Hardhat accounts), T11 (deploy) | none |
| `PAYWALL_RELAYER_KEY` | T9, T10, T11, T16 — facilitator relayer signer | none |
| `PLATFORM_TREASURY_ADDRESS` | T11 (constructor arg) | none |
| `PAYMENT_SPLITTER_FACTORY_ADDRESS` | T17 — read after deploy | populated by T11 patch |
| `REGISTER_KEY` | scripts/register.ts — developer EOA signer | none |
| `ARC_TESTNET_E2E` | T10 — flag to enable live e2e | `0` |

T3 must NOT introduce `ARC_TESTNET_RPC_URL` / `ARC_TESTNET_PRIVATE_KEY`. Use canonical names above.

## 4. Canonical error reason strings (used by both verify.ts and tests)

These ARE the canonical wire-format codes. T7 implementation and T9 tests both must use these exactly:

- HTTP 402 with `error` field:
  - `payment_required` — missing X-PAYMENT header
  - `invalid_signature` — EIP-712 recover != authorization.from, OR domain tamper
  - `insufficient_amount` — value < maxAmountRequired (extra fields `required`, `received`)
  - `authorization_expired` — validBefore ≤ now + 5_000
  - `authorization_not_yet_valid` — validAfter > now
  - `nonce_already_used` — NonceStore hit
  - `network_mismatch` — payload.network ≠ config.network after normalization
  - `paused` — factory.paused() == true
  - `vault_not_deployed` — factory.vaults(developerEoa) == 0x0
  - `settlement_failed` — with `reason` ∈ { `rpc_timeout`, `rpc_5xx`, `gas_estimate_revert`, `mine_timeout`, `receipt_reverted`, `relayer_no_balance`, `authorization_already_used_onchain` }
  - `to_mismatch` — authorization.to ≠ expected vault address (was `recipient_mismatch` in earlier draft — DON'T use that)
- HTTP 400:
  - `header_too_large` — X-PAYMENT > 4 KB pre-decode
  - `malformed_payment_header` — base64 parse fail OR JSON parse fail OR strict-shape fail

## 5. Shared resources ownership (per D13 + Solution)

| Resource | Owner | Consumers |
|---|---|---|
| viem `PublicClient` (Arc RPC reader) | `core.ts` (lazy-init per network, cached across requests) | `verify.ts` reads, `settle.ts` reads receipt/balance |
| viem `WalletClient` (relayer signer) | **`settle.ts`** (it owns the OpaqueRelayerKey extract symbol per D13) | only `settle.ts` itself |
| `NonceStore` | `core.ts` (process-singleton) | `verify.ts` |
| `factory.paused()` / `factory.vaults` cache (TTL 5s) | `core.ts` | `core.ts` only (it's the policy enforcement point) |
| `NETWORKS` registry | `networks.ts` (module const) | all consumers |
| `OpaqueRelayerKey` instance | passed through `PaywallConfig` → `core.ts` (held opaque) → `settle.ts` (only extractor) | never JSON-stringified |

**Conflict resolution:** T7 (settle.ts) creates and owns WalletClient. T7 also owns chainId pin check (since it's the first writeContract caller per request). T8 (core.ts) passes the OpaqueRelayerKey instance to settle.ts; core never extracts.

## 6. parseUsdPrice owner

`parseUsdPrice(input: string): bigint` lives in `packages/middleware/src/x402.ts` (Task 6). It's used by `build402Body` to compute `maxAmountRequired` from the developer's `price: '0.01'` config field. T9 tests it from there.

## 7. T4/T5 withdraw transfer order (canonical: developer FIRST, then platform)

`PaymentVaultImpl.withdraw()` order:

```
gross = IERC20(factory.usdc()).balanceOf(address(this));
require(gross > 0, "no_balance");
fee = gross * factory.feeBps() / 10000;
net = gross - fee;
SafeERC20.safeTransfer(usdc, developer, net);     // developer FIRST
if (fee > 0) SafeERC20.safeTransfer(usdc, factory.platformTreasury(), fee);  // platform SECOND
emit Withdrawal(developer, gross, fee);
```

Matches `code-research.md`. T5 reentrancy test (`MaliciousDeveloper` that re-enters on receiving USDC) is the correct attack vector. ReentrancyGuard blocks it.

## 8. T6 arc-mainnet placeholder

Use `enabled: false` with `chainId: 0` (placeholder, not a real network). Specifically:

```ts
'arc-mainnet': {
  id: 'eip155:0',
  alias: 'arc-mainnet',
  chainId: 0,
  enabled: false,
  // all other fields '0x0' placeholder — fill when Circle launches
}
```

Do NOT use `eip155:42161` — that's Arbitrum One's real CAIP-2. False-positive network matches result.

## 9. `npm run test:e2e` script

Added to `packages/middleware/package.json` by T1 (initial scaffolding):

```json
"scripts": {
  "test": "vitest run",
  "test:e2e": "vitest run src/__tests__/integration/"
}
```

T10 creates the integration test file at `packages/middleware/src/__tests__/integration/arc-testnet-e2e.test.ts`. T17 invokes `npm run test:e2e --workspace=@universal-paywall/middleware` and the script resolves.

## 10. T17 read-factory script

Inline in T17 — no separate file. T17's "What to do" creates a temporary `scripts/postdeploy/read-factory.mjs` AT EXECUTION TIME inside the task's bash steps, runs it, then removes it. Document this explicitly so an executor doesn't look for a pre-existing file.

Alternative: collapse to a single one-liner `node -e "..."` invocation inline in Verify-smoke. Pick the one-liner — fewer moving parts. Drop the file reference.

## 11. T15 forked-e2e command

Remove the line 33 parenthetical claiming forked-e2e runs under `npm test --workspace=packages/middleware`. The forked-e2e suite lives in `contracts/test/integration/forked-e2e.test.ts` and is run by `cd contracts && npx hardhat test`. Update both line 33 and 34 to make this explicit:

- Run `npm test --workspace=@universal-paywall/middleware` — covers middleware vitest suite
- Run `cd contracts && npx hardhat test && npx hardhat coverage` — covers contracts + forked-e2e
- Run `ARC_TESTNET_E2E=1 npm run test:e2e --workspace=@universal-paywall/middleware` — covers live Arc Testnet e2e

## 12. T13/T14 decisions.md race condition

T12, T13, T14 all run in Wave 10 (parallel). T12 (Code Audit) writes `decisions.md` post-completion. T13 and T14 list `decisions.md` as a Context File to READ at audit start.

Fix: remove `decisions.md` from T13 and T14 Context Files. They depend on the artifact tree (source code + tests), not on T12's report. `decisions.md` is a feature-level summary maintained by the orchestrator after the wave, not an audit input.

## 13. Networks.ts sentinel comments (T6 ↔ T11 coordination)

T6 creates `networks.ts` with marker comments around mutable fields:

```ts
'arc-testnet': {
  // ...
  factoryAddress: '0x0000000000000000000000000000000000000000' /* deploy-script:factoryAddress */,
  vaultImplAddress: '0x0000000000000000000000000000000000000000' /* deploy-script:vaultImplAddress */,
  splitterAddress: '0x0000000000000000000000000000000000000000' /* deploy-script:splitterAddress */,  // legacy, kept for backwards-compat if needed
}
```

T11's deploy script does `sed`-style replace on the sentinel-anchored line. Document both sides.
