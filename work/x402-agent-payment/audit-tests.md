# Test Audit — x402-agent-payment

## Verdict

PASS — coverage thresholds met (middleware 96.87% lines / 89.18% branches; contracts 100% branches on `src/`), all hard requirements satisfied (`VaultInvariants.t.sol` exists with 3 invariants, `testFuzz_FeeMath` + `testFuzz_RegisterIdempotent` present, dynamic `MockMaliciousTreasury` reentrancy test present, slither reentrancy detection clean, cross-adapter NonceStore replay test present in single-process forked-e2e), every tech-spec Testing Strategy bullet maps to an executable test. Three low-severity findings flagged for follow-up (no blocking gaps).

## Coverage

### Middleware (vitest v8) — target ≥85% lines

| Metric | Value | Gate |
|--------|-------|------|
| Statements | 96.87% | PASS |
| Branches | 89.18% | PASS |
| Functions | 100.00% | PASS |
| Lines | 96.87% | PASS |

Per-file (≥85% on every production module):
- `errors.ts` 100% / 100%
- `replay-store.ts` 100% / 100%
- `relayer-key.ts` 100% / 100%
- `verify.ts` 100% / 100%
- `adapters/fastify.ts` 100% / 100%
- `adapters/node-http.ts` 100% / 100%
- `core.ts` 96.5% lines / 86.02% branches
- `settle.ts` 95.89% lines / 84.48% branches
- `x402.ts` 95.76% lines / 86.48% branches
- `networks.ts` 86.5% lines / 42.85% branches — only above-threshold module on lines; the uncovered branches are the T3-artefact `BLOCKER` paths and the boot-warning `notes[]` console.warn loop (defensive boot paths suppressed under `UP_SUPPRESS_T3_NOTES=1` in the test runner). Acceptable; the module's behavior is fully exercised by the artifact-comparison test (`networks.test.ts:25-58`) plus the integration suites.

Source: `npm test --workspace=@universal-paywall/middleware -- --coverage --reporter=basic` exit 0; 253 tests passed, 2 skipped (the 2 skips are `arc-testnet-e2e.test.ts` live calls gated on `ARC_TESTNET_E2E=1`, as designed per addendum §4 T10).

### Contracts (`forge coverage --report lcov`, scope: `contracts/src/` only) — target ≥95% branches

| Metric | Value | Gate |
|--------|-------|------|
| Branches | 100.00% (10/10) | PASS |
| Lines | 94.00% (47/50) | INFO (branches are the gate) |

Per-file (lcov, `SF:` prefix filtered to `src/`):
- `src/PaymentSplitterFactory.sol` — branches 6/6 (100%), lines 29/31 (93.55%). Uncovered: lines 97, 100, 101 — these are the `_pause()` / `_unpause()` bodies inside the `pause()` / `unpause()` functions. **However, `forge test` includes `test_Pause_BlocksRegister`, `test_Unpause_RestoresRegister`, and `test_Pause_OwnerOnly` / `test_Unpause_OwnerOnly`** — the line miss is a known LCOV instrumentation quirk for single-statement Solidity functions wrapping inherited modifiers, not a real coverage gap. The branch metric (which is the gate) is 100% on this file.
- `src/PaymentVaultImpl.sol` — branches 4/4 (100%), lines 18/19 (94.74%). One uncovered line (51) is the OZ `Initializable` constructor `_disableInitializers()` call line — instrumented as an unreached helper because it runs only during impl-deploy and forge-coverage's deterministic harness skips the constructor counter. Functionally exercised by `test_D15_DirectInitializeOnImplReverts`.

Exclusions applied: `test/`, `script/`, `lib/` are not included in the numerator/denominator computation. The lcov.info file does include `SF:test/...` blocks (forge's default output behavior) but the auditor's `awk` filter on `^src/` excludes them.

Source: `cd contracts && forge coverage --report lcov` exit 0; `awk` per-file aggregation over `lcov.info`.

### Forge test execution

- `cd contracts && forge test` → 52 passed / 0 failed (29 factory + 20 vault + 3 invariants).
- `cd contracts && FOUNDRY_PROFILE=ci forge test --match-test 'testFuzz_|invariant_' -vv` → fuzz runs=1000 each, invariant runs=256 each (foundry.toml `[profile.ci]` correctly applied), all pass.
- `cd contracts && slither --detect reentrancy-eth,reentrancy-no-eth src/` → 0 findings.

## Forge Fuzz & Invariant Inventory (HARD requirements per addendum §4 T14)

### `contracts/test/invariants/VaultInvariants.t.sol` — EXISTS

Three handler-based stateful invariants (≥3 required; PASS):

1. `invariant_VaultBalanceIntegrity` (line 104) — asserts `mockUsdc.balanceOf(vault) == handler.totalMinted() - handler.totalWithdrawn()`. Backed by `VaultHandler.depositToVault` + `VaultHandler.withdrawFromVault` bound entry points and `targetSelector` whitelist, with reverts=0 and 16,384 / 128,000 calls per run (default / standard profile).
2. `invariant_FeeBpsBounded` (line 113) — asserts `factory.feeBps() <= 1000`. Exercised via `VaultHandler.setFeeBps` (bps bounded to `[0, 1000]` inside the handler; the invariant pins the cap from the factory side).
3. `invariant_DeveloperNonZero` (line 118) — asserts `vault.developer() != address(0)` once `initialize()` has run. Pins D17 immutability on the dev field.

Handler design is sound: `targetContract(address(handler))` + explicit `bytes4[]` selector whitelist restricts the fuzzer to bounded entry points, preventing wasted budget on trivially-reverting random calls. Comments document the intentional omission of `factory.pause()` from handler selectors (D12 unpausable withdraw — toggling pause would not exercise additional vault states).

### Fuzz tests — both present

- `testFuzz_FeeMath(uint256 gross, uint16 feeBps)` — `contracts/test/PaymentVaultImpl.t.sol:285`. Bounds `gross` to `[1, 1e18]` and `feeBps` to `[0, 1000]`, asserts split sum identity (`net + fee == gross`), no overflow (`fee <= gross`), and that the vault is fully drained.
- `testFuzz_RegisterIdempotent(address dev)` — `contracts/test/PaymentSplitterFactory.t.sol:307`. `vm.assume(dev != address(0))` and `uint160(dev) > 9` (excluding precompile range); asserts second `register()` reverts `AlreadyRegistered`.

Other fuzz tests: none beyond the two HARD-required ones. (`invariant_*` tests are stateful fuzzing.)

## Tech-spec Testing Strategy Coverage Matrix

### Unit tests (vitest, ≥85% line coverage)

| Tech-spec requirement | Test file::test name | Status |
|----------------------|---------------------|--------|
| x402 codec — 402 body builder ajv-validated against vendored x402 v1 schema | `x402.test.ts:89 (build402Body output validates against vendored x402 v1 JSON Schema)` + `x402.test.ts:412 (decoded valid payload validates against PaymentPayload schema)` + `errors.test.ts:170 (insufficient_amount body validates against schema)` | PRESENT |
| x402 codec — decoder handles missing/invalid fields | `x402.test.ts:162-373` (12 rejection tests covering extra keys, malformed JSON, wrong x402Version, non-decimal numerics, etc.) | PRESENT |
| x402 codec — header size cap | `x402.test.ts:151 (rejects header > 4096 bytes)` | PRESENT |
| Network id normalization CAIP-2 ↔ alias round-trips | `networks.test.ts:60-72 (returns canonical for both forms of arc-testnet / arc-mainnet placeholder / unknown id)` | PRESENT |
| verify — valid signature passes | `verify.test.ts:94` | PRESENT |
| verify — tampered chainId fails | `verify.test.ts:100 (tampered chainId fails as invalid_signature)` | PRESENT |
| verify — tampered verifyingContract fails | `verify.test.ts:108` | PRESENT |
| verify — tampered domain.name fails | `verify.test.ts:118` | PRESENT |
| verify — tampered domain.version fails | `verify.test.ts:124` | PRESENT |
| verify — `to != computedVaultAddress` returns `to_mismatch` | `verify.test.ts:130 (to mismatch fails as to_mismatch)` | PRESENT |
| verify — `value < required` fails | `verify.test.ts:136 (value below required fails as insufficient_amount)` | PRESENT |
| verify — `validBefore <= now + 4s` fails, `validBefore == now + 6s` passes | `verify.test.ts:142 (validBefore @ +4 fails)` + `verify.test.ts:150 (validBefore @ +5 exact boundary fails — guard is <=)` + `verify.test.ts:160 (validBefore @ +6 passes)` | PRESENT |
| verify — `validAfter > now` returns `authorization_not_yet_valid` | `verify.test.ts:168` | PRESENT |
| verify — network mismatch fails | `verify.test.ts:182` + `verify.test.ts:188 (CAIP-2 and alias normalize equal)` | PRESENT |
| replay-store — synchronous has+insert; same `(from,nonce)` twice → reject | `replay-store.test.ts:10` + `:174` | PRESENT |
| replay-store — TTL eviction | `replay-store.test.ts:61 (lazy TTL eviction: expired entries are dropped on subsequent has())` | PRESENT |
| replay-store — 100k cap eviction | `replay-store.test.ts:117 (cap eviction by oldest validBefore)` | PRESENT |
| settle — `rpc_timeout` | `settle.test.ts:189 (rpc TimeoutError → rpc_timeout)` + `:447 (balanceOf TimeoutError → rpc_timeout)` | PRESENT |
| settle — `rpc_5xx` | `settle.test.ts:202 (HttpRequestError 502 → rpc_5xx)` + `:218 (HttpRequestError 429 → rpc_5xx — any HTTP error bucket)` + `:174 (non-bigint balance → rpc_5xx)` | PRESENT |
| settle — `gas_estimate_revert` | `settle.test.ts:238 (ContractFunctionExecutionError during writeContract → gas_estimate_revert)` + `:332 (revert reason that cannot be matched → gas_estimate_revert)` | PRESENT |
| settle — `mine_timeout` | `settle.test.ts:255 (WaitForTransactionReceiptTimeoutError → mine_timeout)` | PRESENT |
| settle — `receipt_reverted` | `settle.test.ts:267 (receipt status 'reverted' → receipt_reverted)` | PRESENT |
| settle — `relayer_no_balance` (proactive + reactive) | `settle.test.ts:134 (balance 0 proactive — writeContract NOT called)` + `:149 (just below MIN)` + `:164 (equal to MIN passes — strict <)` + `:277 (reactive InsufficientFundsError)` | PRESENT |
| settle — `authorization_already_used_onchain` (case-insensitive substring) | `settle.test.ts:290` + `:312 (case variant uppercase still matched)` | PRESENT |
| Replay-store retention on settlement failure | `core.test.ts:749 (replay-store entry is retained after settlement failure — retry returns nonce_already_used)` + `replay-store.test.ts:155 (checkAndInsert then re-check without explicit delete → still rejects)` | PRESENT |
| relayer-key — JSON.stringify, toString, util.inspect, structuredClone redact | `relayer-key.test.ts:14,19,25,30` | PRESENT |
| relayer-key — pino serialization | `relayer-key.test.ts:59` | PRESENT |
| relayer-key — winston serialization | `relayer-key.test.ts:75` | PRESENT |
| relayer-key — error stacks redact `0x[a-f0-9]{64}` | `relayer-key.test.ts:202` | PRESENT |
| relayer-key — non-enumerable field | `relayer-key.test.ts:36 (key field is non-enumerable)` | PRESENT |
| D14 startup chainId pin → `NetworkMismatchError` | `settle.test.ts:119 (chainId pin mismatches → NetworkMismatchError with expected/observed)` + `:440 (exported with chainId fields)` + `core.test.ts:570 (settle throws NetworkMismatchError → emit chain_id_mismatch + 402)` | PRESENT |
| D18 SecurityLogger — all 10+ event names emit on trigger | `core.test.ts:174,186,207,220 (header/malformed)` + `:233,251 (paused, vault_not_deployed)` + `:341,419 (rpc_5xx)` + `:487-518 (7 settle reasons)` + `:549 (relayer_low_balance)` + `:570 (chain_id_mismatch)` + `:619-642 (table-driven verify→D18 mapping: signature_invalid, nonce_replay_attempt, authorization_expired, authorization_not_yet_valid, network_mismatch, to_mismatch, insufficient_amount)`. All 14 declared `SecurityEventName` keys have a trigger test. | PRESENT |
| D18 SecurityLogger — default no-op logger silent | `core.test.ts:717 (default no-op logger produces no output when opts.logger is undefined)` | PRESENT |
| D18 — payloads pass through redactor (no raw sig) | `core.test.ts:515 (serialized payload does not contain SIG)` + `:822 (logger payloads never contain raw addresses or signatures — payerHash is the 10-char form)` | PRESENT |
| Factory-state cache — 5s TTL | `core.test.ts:288 (cache hits within 5s TTL)` + `:299 (refresh after 5s TTL — uses vi.useFakeTimers)` + `:320 (non-zero vault NOT re-fetched after TTL)` | PRESENT |
| Factory-state cache — RPC error returns last good if non-stale | `core.test.ts:362 (RPC error with non-stale cache returns last-good value passthrough)` | PRESENT |
| Factory-state cache — otherwise propagates as `settlement_failed.reason="rpc_5xx"` | `core.test.ts:341 (no cache → rpc_5xx)` + `:419 (STALE cache → rpc_5xx)` | PRESENT |
| Adapter — `withPaywall` propagates handler exceptions | `adapters/node-http.test.ts:107 (propagates handler exceptions unchanged)` | PRESENT |
| Adapter — `withPaywall` sets response headers | `adapters/node-http.test.ts:47,67,81` | PRESENT |
| Adapter — `withPaywall` flushes before user handler | `adapters/node-http.test.ts:81 (sets X-PAYMENT-RESPONSE before invoking user handler)` | PRESENT |
| Adapter — `fastifyPaywall` integrates Fastify `preHandler` | `adapters/fastify.test.ts:22 (preHandler sends 402)` + `:47 (400)` | PRESENT |
| Adapter — `fastifyPaywall` 402 when X-PAYMENT absent | `adapters/fastify.test.ts:22` | PRESENT |
| Adapter — `fastifyPaywall` preserves reply chaining on 200 | `adapters/fastify.test.ts:62` + `:77 (route handler runs and is the sole sender)` | PRESENT |
| errors.ts — each reason produces canonical body matching schema | `errors.test.ts:62-181` (16 tests including ajv-validation) | PRESENT |
| Price parsing edge cases | `x402.test.ts:106-142` (accepted + rejected: zero, >6 decimals, abc/empty/-1/0/.5/NaN, scientific, whitespace) | PRESENT |

### Contract tests (Foundry, ≥95% branch coverage)

| Tech-spec requirement | Test file::test name | Status |
|----------------------|---------------------|--------|
| Factory `register` — deploys vault at predicted address | `PaymentSplitterFactory.t.sol:52 (test_Register_DeploysVaultAtPredictedAddress)` | PRESENT |
| Factory `register` — `vaults[developer]` populated | `:59 (test_Register_PopulatesVaultsMapping)` | PRESENT |
| Factory `register` — idempotent reverts `AlreadyRegistered` | `:73 (test_Register_RevertsAlreadyRegistered)` + `testFuzz_RegisterIdempotent` | PRESENT |
| Factory `register` — paused reverts `EnforcedPause` | `:81 (test_Register_RevertsWhenPaused)` | PRESENT |
| Factory `register` — vault `initialize` called once with `_developer = msg.sender` | `:66 (test_Register_VaultInitializedWithDeveloper)` + `PaymentVaultImpl.t.sol:48 (test_Initialize_RevertsOnSecondCall)` | PRESENT |
| CREATE2 cross-component invariant — Solidity `Clones.predictDeterministicAddress` matches `factory.computeVaultAddress` for ≥3 EOAs | `PaymentSplitterFactory.t.sol:92 (test_Register_PredictedAddressMatchesClonesPredict — iterates dev1/dev2/dev3)` | PRESENT |
| `register` reentrancy invariant — slither structural detection | `slither --detect reentrancy-eth,reentrancy-no-eth contracts/src/` returns 0 findings; NatSpec docblock on `register()` pins the invariant; comment block at `PaymentSplitterFactoryTest.t.sol:14-20` documents the slither gate | PRESENT |
| `setFeeBps` owner-only, reverts on > 1000, emits | `:114,121,129,137` | PRESENT |
| `setPlatformTreasury` owner-only, reverts on zero, emits | `:147,155,160` | PRESENT |
| `Ownable2Step` two-step happy path + cancel | `:172,184,195` | PRESENT |
| `pause`/`unpause` owner-only | `:211,218,226,234` | PRESENT |
| Constructor reverts on zero usdc/treasury/feeBps > 1000 | `:247,252,257` + happy-path `:262,270` | PRESENT |
| `VaultDeployed` event arg matches predicted address; unregistered → `0x0`; two devs same block → distinct addresses | `:280,288,293` | PRESENT |
| Vault `initialize` is single-call | `PaymentVaultImpl.t.sol:40,48,54` | PRESENT |
| **D15** `_disableInitializers()` on impl — direct `initialize` on `vaultImpl` (not a clone) reverts | `:67 (test_D15_DirectInitializeOnImplReverts)` | PRESENT |
| **D16** No `receive()` / `fallback()` — sending native to vault reverts | `:79 (test_D16_NativeTransferReverts)` | PRESENT |
| **D17** ABI assertions — no `setDeveloper(address)` / `setFactory(address)` selectors | `:89 (test_D17_NoSetDeveloperSelector)` + `:95 (test_D17_NoSetFactorySelector)` | PRESENT |
| `withdraw` — developer-only, `NoBalance`, happy path split, `Withdrawal` event | `:109,117,123` | PRESENT |
| Fee edge — `feeBps = 0` → no second transfer | `:150 (test_Withdraw_FeeBps0_NoSecondTransfer)` | PRESENT |
| Fee edge — `feeBps = 1000` → 10% fee | `:161 (test_Withdraw_FeeBps1000_Splits90_10)` | PRESENT |
| Fee edge — 1 micro-USDC → fee=0 truncation, full unit to dev | `:171 (test_Withdraw_DustGrossTruncatesFee)` + boundary `:180,189` | PRESENT |
| Fee-snapshot semantics — withdraw uses fee at withdraw time | `:205 (test_Withdraw_UsesCurrentFeeBpsAtWithdrawTime)` | PRESENT |
| Reentrancy dynamic — `MockMaliciousTreasury` re-enters `vault.withdraw()` → blocked by `ReentrancyGuard` | `:224 (test_Withdraw_ReentrancyBlocked_ViaMaliciousTreasury)` using `test/mocks/MockMaliciousTreasury.sol` + `test/mocks/MockUsdcWithHook.sol`; asserts `ReentrancyGuard.ReentrancyGuardReentrantCall.selector` and verifies state rollback | PRESENT |
| Withdraw works when factory `paused()` | `:272 (test_Withdraw_WorksWhenFactoryPaused)` | PRESENT |
| **HARD** `testFuzz_FeeMath` — no-overflow, fee+net == gross | `PaymentVaultImpl.t.sol:285 (testFuzz_FeeMath, runs=1000)` | PRESENT |
| **HARD** `testFuzz_RegisterIdempotent` — re-register reverts `AlreadyRegistered` | `PaymentSplitterFactory.t.sol:307 (testFuzz_RegisterIdempotent, runs=1000)` | PRESENT |
| **HARD** Invariants file with ≥3 invariants | `contracts/test/invariants/VaultInvariants.t.sol` — 3 invariants (see inventory above) | PRESENT |

### Forked integration + e2e + CLI

| Tech-spec requirement | Test file::test name | Status |
|----------------------|---------------------|--------|
| forked-e2e — full happy path against BOTH adapters (Node http + Fastify) in same process | `integration/forked-e2e.test.ts:631 (node-http happy path)` + `:710 (fastify happy path)` | PRESENT |
| **Cross-adapter replay protection** — pay via Node http, retry SAME header on Fastify → 402 `nonce_already_used` (single process — proves process-singleton NonceStore) | `integration/forked-e2e.test.ts:771 (cross-adapter NonceStore replay rejection)` | PRESENT |
| forked-e2e — anvil spawned + contracts deployed via viem programmatic deploys reading bytecode from `contracts/out/` | `integration/forked-e2e.test.ts:101 (CONTRACTS_OUT resolved)` + `readArtifact()` helper + `beforeAll` deploys via `walletDeployer.deployContract` | PRESENT |
| forked-e2e — 200 received, vault USDC balance grows, NonceStore rejects replay, on-chain `usdc.authorizationState(from, nonce)` true after settle | `integration/forked-e2e.test.ts:631,710` (each happy path asserts balanceOf delta + authorizationState true) | PRESENT |
| forked-e2e — rejection branches `vault_not_deployed` and `paused` | `:799 (vault_not_deployed)` + `:826 (paused rejection — factory.pause() → wait for cache TTL → signed request → 402)` | PRESENT |
| live Arc Testnet e2e (gated by `ARC_TESTNET_E2E=1`) | `integration/arc-testnet-e2e.test.ts:235 (402 body matches schema)` + `:248 (live settle 200 + vault balance increases)` + `:342 (skipped without env flag — default CI invocation)` | PRESENT |
| Register CLI — runs against anvil + factory, tx hits `factory.register()` | `register-cli.test.ts:275 (register_calls_factory — happy path)` + `:311 (already_registered idempotent)` | PRESENT |
| Register CLI — **stdout/stderr scrub** — never prints developer key | `register-cli.test.ts:332 (register_never_prints_key — no 32-byte hex appears)` + `:455 (register_never_prints_key_on_rpc_failure — error classification path scrubs hex keys)` | PRESENT |
| Register CLI — incorrect REGISTER_KEY format → non-zero exit with typed error not exposing input | `register-cli.test.ts:355 (register_rejects_malformed_key — exit 2, stderr omits the input)` + `:376 (missing key — exit 2)` + `:386 (disabled network — exit 3)` | PRESENT |

## Mandatory Items (call out individually)

- ajv schema validation of 402 body: PRESENT — `packages/middleware/src/__tests__/fixtures/x402-v1.schema.json` vendored; assertions in `x402.test.ts:89`, `:412`, `errors.test.ts:170`, `integration/forked-e2e.test.ts` (initial 402 body schema check), `integration/arc-testnet-e2e.test.ts:235`. `additionalProperties: false` on every definition.
- EIP-712 tamper tests (4 of them): PRESENT —
  - chainId: `verify.test.ts:100`
  - verifyingContract: `verify.test.ts:108`
  - domain.name: `verify.test.ts:118`
  - domain.version: `verify.test.ts:124`
- Network id normalization (CAIP-2 ↔ alias) round-trips: PRESENT — `networks.test.ts:60-72` covers both arc-testnet and arc-mainnet entries plus unknown-id rejection.
- Settlement failure taxonomy (7 reasons): PRESENT — every reason has a dedicated test in `settle.test.ts`:
  - `rpc_timeout` :189, :447
  - `rpc_5xx` :202, :218, :174
  - `gas_estimate_revert` :238, :332
  - `mine_timeout` :255
  - `receipt_reverted` :267
  - `relayer_no_balance` :134, :149, :164, :277
  - `authorization_already_used_onchain` :290, :312
- CREATE2 cross-component invariant (Solidity-side `Clones.predictDeterministicAddress`, ≥3 EOAs): PRESENT — `PaymentSplitterFactory.t.sol:92` iterates dev1/dev2/dev3.
- `_disableInitializers()` impl-hijack: PRESENT — `PaymentVaultImpl.t.sol:67`.
- ABI no-receive/no-setter assertions: PRESENT — `PaymentVaultImpl.t.sol:79 (native transfer reverts)` + `:89,95 (no setDeveloper/setFactory selectors)`.
- Fee math edge cases (0/1000/1 micro-USDC/snapshot): PRESENT — `PaymentVaultImpl.t.sol:150,161,171,180,189,205`.
- Cross-adapter replay protection in forked-e2e: PRESENT — `integration/forked-e2e.test.ts:771`; verified single-process design (one `anvil` spawn + one `vitest` worker; both servers in the same module).
- Both adapters covered (Node http + Fastify) in unit + forked-e2e: PRESENT — unit (`adapters/node-http.test.ts`, `adapters/fastify.test.ts`) + forked-e2e (`:631` node, `:710` fastify, `:771` cross-adapter).
- relayer-key redaction:
  - util.inspect: PRESENT — `relayer-key.test.ts:25`
  - pino: PRESENT — `relayer-key.test.ts:59`
  - winston: PRESENT — `relayer-key.test.ts:75`
  - structuredClone: PRESENT — `relayer-key.test.ts:30`
- Factory-state cache TTL tests (5s TTL, RPC error fallback behavior): PRESENT — `core.test.ts:288,299,320,341,362,419` (uses `vi.useFakeTimers()` — no sleep flakiness).
- Register CLI scrub test: PRESENT — `register-cli.test.ts:332,455`.
- Foundry reentrancy dynamic test (MockMaliciousTreasury): PRESENT — `PaymentVaultImpl.t.sol:224`; mock at `test/mocks/MockMaliciousTreasury.sol`; hook-enabled USDC at `test/mocks/MockUsdcWithHook.sol`; asserts `ReentrancyGuard.ReentrancyGuardReentrantCall.selector` and verifies state rollback.

## Test Quality Findings

### Meaningful assertions — PASS

Spot-checked across all suites. Examples of high-value assertions:
- Settle failure tests assert both the resulting 402 body and the SecurityLogger emission shape (`core.test.ts:486-518`).
- Fuzz tests assert algebraic identities (`net + fee == gross`, `fee <= gross`) not just truthiness (`PaymentVaultImpl.t.sol:303-305`).
- Cross-adapter NonceStore test asserts the literal `'nonce_already_used'` reason on the second hit (`integration/forked-e2e.test.ts:796`).
- Token redaction tests assert exact substring absence and presence of `redacted` marker (`relayer-key.test.ts:131-152`).

No test was found that relies on `toBeTruthy()` / `not.toThrow()` as its only assertion for a non-trivial path.

### Test isolation — PASS

- Vitest config sets `isolate: true` per file (default), each test file gets its own module registry.
- `beforeEach` blocks reset module-scope caches (`__resetSettleCacheForTests`, `vi.clearAllMocks`) — example at `settle.test.ts:81-89`.
- `forked-e2e` test mutates `NETWORKS` for anvil but restores it in `afterAll` via `patchNetworksForAnvil` returning a teardown closure (`integration/forked-e2e.test.ts:340-393`). No cross-file bleed.
- `register-cli.test.ts` uses `NODE_ENV=test` + `TEST_FACTORY_ADDRESS` env to bypass production NETWORKS, so it does not depend on or mutate the global registry.
- Foundry tests are by definition isolated per-test (`forge` resets the EVM state between each `test_*` function); invariant runner uses bounded handler entry points.

No order-dependence detected. Tests can be run in any order.

### Mock realism — PASS with two observations

PASS overall — mocks return shapes that match the real RPC/contract responses:
- `MockUsdcEip3009.sol` implements the full EIP-3009 surface (`transferWithAuthorization`, `authorizationState`, EIP-712 domain) with the same `name = "USD Coin"` / `version = "2"` that Circle's FiatTokenV2_2 uses. The forked-e2e test uses this same mock, so the signature path mirrors production cryptography.
- `helpers/mock-clients.ts` `MockPublicClient` covers exactly `getChainId`, `readContract` (paused / vaults / balanceOf), and `waitForTransactionReceipt` — the methods `verify.ts` + `settle.ts` actually call. The `readContract` mock throws on unhandled `functionName` (line 37) so a new RPC call from production code would surface as a test failure rather than silently passing.
- Settle tests `vi.mock('viem', ...)` partially mocks only `createWalletClient` + `http`, preserving `privateKeyToAccount` + `signTypedData` from the real viem (`settle.test.ts:70-79`) — so cryptographic correctness is exercised even in unit tests.

Observations (not findings — operational):
1. The forked-e2e and register-cli tests deploy `MockUsdcEip3009` with `name = "USD Coin"`, but the live Arc Testnet USDC returns `name = "USDC"` (T3 spike artifact). This intentional divergence is documented in `decisions.md` (Task 3) and the live `arc-testnet-e2e.test.ts` uses the correct production name `"USDC"`. The forked suite cannot detect a future drift where production USDC changes `name`, but this is an acceptable mock/prod gap (the production gate is the live e2e test).
2. `MockUsdcEip3009.transferWithAuthorization` does not validate signatures — it just records the authorization as used. This is fine for unit/contract-test isolation (the signature path is exercised by viem's real recovery in `verify.ts`), but the forked-e2e and live-arc tests are the only signature round-trip checks against real EIP-712 recovery + on-chain `authorizationState` storage.

### Sleep-based flakiness — PASS with one explicit waiver

All deterministic time-control paths use `vi.useFakeTimers()` correctly (factory-state cache TTL tests in `core.test.ts:299,320`; replay-store TTL uses parameter-driven `now` not `Date.now`).

Real `setTimeout` waits exist in three places, all justified:
- `integration/forked-e2e.test.ts:134` — 250 ms poll interval in `waitForPort` for anvil readiness. Not a synchronization wait inside a test, but a startup gate.
- `integration/forked-e2e.test.ts:310` — 2 s grace period for anvil SIGTERM → SIGKILL escalation in teardown.
- `integration/forked-e2e.test.ts:861` — **8 s sleep** to allow the middleware's 5 s factory-state cache TTL to elapse before issuing the paused-request test. This is a real-clock wait in a forked-network test where the cache is on `Date.now()`. Acceptable: the suite has 60 s `testTimeout`; the 3 s margin protects against GC pauses. **Could be improved** (low) — mark with a `vi.mock('@universal-paywall/middleware/__internal_clock')` injection or split the test so the unit-level TTL coverage (already deterministic in `core.test.ts:299`) is the authoritative gate and the e2e simply pins the path-coverage. As written it is not flaky but does add ~8 s to every forked-e2e run.
- `register-cli.test.ts:114` — 200 ms wait for anvil port readiness; same justification as forked-e2e.

No raw `vm.sleep` patterns in forge tests; `vm.warp` not used (no time-dependent contract logic).

### Over-mocking — PASS

No instance of mocking the unit under test or mocking away the assertion's subject was found:
- `verify.ts` is exercised against real `recoverTypedDataAddress` from viem (no mock).
- `settle.ts` mocks only `createWalletClient` + `http` (the network seams) — the classifier under test is real.
- `core.ts` tests mock the downstream `verifyEip3009Authorization` + `settleOnChain` boundaries (the verify/settle modules have their own dedicated tests) — this is correct factored unit-test design, not over-mocking.
- `paywall pipeline` happy-path tests in `core.test.ts` mock `verifySpy` + `settleSpy` to inject specific results, then assert the SecurityLogger emit + 402 body. Correct: the assertion's subject (core's mapping logic) is real; the mocked downstream is configured to drive specific code paths.
- `MockMaliciousTreasury` is a stub for the malicious treasury behavior, NOT for the vault's ReentrancyGuard — the assertion's subject (OZ ReentrancyGuard inside `vault.withdraw()`) is fully real.

## Recommendations

(Low-severity — no blocking gaps. Pre-deploy QA may proceed.)

1. **L1 — Replace the 8 s real-clock sleep in the forked-e2e paused-request test** (`integration/forked-e2e.test.ts:861`). The unit-level cache TTL test in `core.test.ts:299` already pins the deterministic behavior using `vi.useFakeTimers()`. The forked-e2e variant is a path-coverage smoke; consider splitting it into a smaller test that pauses + immediately issues with a small RPC override that forces a cache miss, removing the 8 s wall-clock dependency. Net savings ~8 s per run; lowers the risk of CI flakes under heavy load.

2. **L2 — Mock/prod USDC name divergence in forked-e2e** (`integration/forked-e2e.test.ts:358,664,725,782,815,872`). The mock USDC returns `name = "USD Coin"` but live Arc Testnet returns `"USDC"`. Both names are intentionally configured at distinct sites and the live e2e test guards the production path, but a single shared constant (`MOCK_USDC_NAME = 'USD Coin'` vs `LIVE_USDC_NAME = 'USDC'`) would document the divergence at the source level and make a future Circle name change easier to absorb.

3. **L3 — Add an LCOV-quirk note to the audit gate command** (operational). `forge coverage --report lcov` reports 3 missed lines in `PaymentSplitterFactory.sol` (lines 97/100/101 — single-statement `_pause()` / `_unpause()` bodies) that are functionally exercised by `test_Pause_BlocksRegister`, `test_Unpause_RestoresRegister`, etc. This is an LCOV instrumentation quirk for inherited modifier wrappers, not a real gap. Branch coverage (the gate) is 100%; the line coverage is for informational use. CI gates should target the branch metric and document the line-coverage quirk to avoid spurious gate failures on Solidity LCOV reports.

## Hard requirement compliance summary

| HARD requirement | Status |
|------------------|--------|
| `contracts/test/invariants/VaultInvariants.t.sol` exists with ≥3 invariants | PASS — 3 invariants present (VaultBalanceIntegrity, FeeBpsBounded, DeveloperNonZero) |
| `testFuzz_FeeMath` present + functioning | PASS — `PaymentVaultImpl.t.sol:285`, runs=1000 under CI profile |
| `testFuzz_RegisterIdempotent` present + functioning | PASS — `PaymentSplitterFactory.t.sol:307`, runs=1000 under CI profile |
| Foundry reentrancy dynamic test (`MockMaliciousTreasury`) present + passing | PASS — `PaymentVaultImpl.t.sol:224` |
| Slither structural reentrancy detection on `register` clean | PASS — 0 findings |
| Middleware line coverage ≥85% | PASS — 96.87% |
| Contracts branch coverage ≥95% on `contracts/src/` | PASS — 100% |
| Cross-adapter replay protection in forked-e2e (single process) | PASS — `integration/forked-e2e.test.ts:771` |
| Both adapters (Node http + Fastify) in unit + forked-e2e | PASS |
| Register CLI scrub test | PASS |
| All 7 settlement failure reasons covered by separate tests | PASS |
| All 4 EIP-712 tamper tests as distinct tests | PASS |
| Network id normalization round-trip + unknown-id rejection | PASS |
| `to_mismatch` dedicated test | PASS |
| `_disableInitializers()` impl-hijack test | PASS |
| ABI assertions (no receive/fallback/setDeveloper/setFactory) | PASS |
| Relayer-key redaction (util.inspect/pino/winston/structuredClone) | PASS |
| Factory-state cache TTL tests (5s TTL + RPC fallback) | PASS |
| Fee math edge cases (0/1000/1 micro/snapshot) | PASS |
