# Feature decisions log: x402-agent-payment

This file accumulates implementation-time decisions and short execution
reports per task. It is created as an empty stub during task-decomposition
so tasks can reference it as a Context File. Tasks append their
post-completion entries here following the `do-task` skill template.

## Decisions

(none yet — populated during feature execution)

## Task execution reports

## Task 1: Monorepo scaffolding (ESM-only)

**Status:** Done
**Commit:** 628c1de (impl: 0272fe3, fixes: 628c1de)
**Agent:** scaffolder
**Summary:** Bootstrapped npm workspace root + `packages/middleware` as ESM-only TypeScript package per spec. Established TypeScript strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax), tsup ESM-only build (target node20, dts on, minify off), Husky v9 + gitleaks pre-commit (middleware lint scope only), and full devDep set (tsup, typescript, tsx, vitest, ajv, pino, winston in middleware; vitest at root) so T6+ can land tests without further `npm install`. Pin invariant: `--passWithNoTests` flag retained in `test`/`test:e2e` until T6 lands first vitest test, documented via `"//test"` sibling key. esbuild force-pinned to ^0.28.1 via root `overrides` to close GHSA-gv7w-rqvm-qjhr (HIGH).
**Deviations:** None from task spec. Two security findings from auditor accepted as documented limitations: (a) vitest stays at ^1.5.0 (task spec pin); upgrade to ^3.2.6 to clear GHSA-5xrq-8626-4rwp is a major migration scoped outside Task 1 — sibling `//audit-vitest` key in middleware scripts forbids `vitest --ui` until upgrade; (b) `prepublishOnly` guard added in middleware (not in original spec) — fail-fast against accidental publish before Task 16. Added `**/tsup.config.ts` to ESLint ignorePatterns (build tooling, not in tsconfig include) — infra-reviewer marked as correct pragmatic call. `.gitignore` updated to also include `.npmrc` (security-auditor SA-T1-03) and `.husky/_/` (husky v9 shim dir).

**Reviews:**

*Round 1:*
- code-reviewer-t1: approved_with_minors (2 minor findings) → [logs/working/task-1/code-reviewer-t1-round1.json](logs/working/task-1/code-reviewer-t1-round1.json)
- security-auditor-t1: conditional_pass (2 medium, 2 low, 2 info findings) → [logs/working/task-1/security-auditor-round1.json](logs/working/task-1/security-auditor-round1.json)
- infrastructure-reviewer-t1: APPROVED (1 advisory, no action) → [logs/working/task-1/infrastructure-reviewer-t1-round1.json](logs/working/task-1/infrastructure-reviewer-t1-round1.json)

*Round 2 (after fixes):*
- code-reviewer-t1: approved (unconditional) → [logs/working/task-1/code-reviewer-t1-round2.json](logs/working/task-1/code-reviewer-t1-round2.json)
- security-auditor-t1: pass → [logs/working/task-1/security-auditor-round2.json](logs/working/task-1/security-auditor-round2.json)
- infrastructure-reviewer-t1: no new findings, round 1 APPROVED stands (no round 2 report file written by reviewer per their preference)

**Verification:**
- `npm install` → success (node 20.19.1, npm 10.8.2); lockfile created
- `npm run lint` → exit 0
- `npm run --workspace=packages/middleware typecheck` → exit 0
- `npm run build --workspace=packages/middleware` → dist/index.js + dist/index.d.ts + dist/index.js.map present
- `npm test --workspace=@universal-paywall/middleware` → exit 0 (vitest 1.6.1, --passWithNoTests)
- `npx vitest --version` from root → 1.6.1
- `npm ls esbuild` → all consumers deduped to 0.28.1 (overrides active)
- gitleaks PEM-key surrogate test → exit 1 (hook blocks correctly)

**Open items for future tasks:**
- T6 implementer: if `ajv` is used in production `src/` code (not just tests), promote from devDependencies to dependencies (code-reviewer T1-M2).
- Pre-MVP: upgrade vitest to ^3.2.6 to clear GHSA-5xrq-8626-4rwp; until then, no `vitest --ui` invocations (enforced by `//audit-vitest` sibling key).
- CI task (separate from T1): add gitleaks as a server-side gate to defend against local `HUSKY=0` / `--no-verify` bypass (security-auditor SA-T1-06).

## Task 2: Foundry contracts workspace scaffolding

**Status:** Done
**Commit:** 628ff4d (impl) + d5c5dc7 (round-1 fixes)
**Agent:** foundry-setup
**Summary:** Initialized the `contracts/` Foundry workspace per tech-spec D8/D9 and iteration-4-addendum §1/§2/§4 T2. Wrote foundry.toml (Solidity 0.8.20, optimizer 200 runs, [profile.ci] fuzz=1000/invariant runs=256 depth=64, arc_testnet rpc endpoint), installed OpenZeppelin v5.0.2 (SHA dbb6104) and forge-std v1.16.1 (SHA 620536f) as git submodules pinned via .gitmodules + foundry.lock, wrote remappings.txt (single OZ remap), slither.config.json (test/lib filter, exclude_low=false), ESM-TS contracts/package.json (devDeps: viem, tsx, typescript, @types/node — no Hardhat stack), tsconfig.json (strict ESM, scripts-only), .env.example (canonical names only), and scripts/export-abi.ts (post-build ABI hook copying forge artifacts to packages/middleware/src/abi/, safe no-op when out/ missing). Smoke checks pass (forge build, npm run build, tsc).
**Deviations:** `forge install --no-commit` flag does not exist in forge 1.6 nightly (no-commit is the default; --commit is opt-in). Flag omitted; behavior matches spec intent (submodule added without auto-commit). foundry.lock auto-generated by forge 1.6+ was committed and documented in foundry.toml as a secondary lock complementing submodule SHA pinning — not in original spec but exceeds reproducibility requirements (T2-C2). Both deviations accepted in round-1 review.

**Reviews:**

*Round 1:*
- code-reviewer-t2: approve_with_minor (2 minor findings T2-C1, T2-C2) → [logs/working/task-2/code-reviewer-t2-round1.json](logs/working/task-2/code-reviewer-t2-round1.json)
- security-auditor-t2: PASS (2 low advisories T2-SEC-01, T2-SEC-02) → [logs/working/task-2/security-auditor-t2-round1.json](logs/working/task-2/security-auditor-t2-round1.json)
- infrastructure-reviewer-t2: APPROVED (1 informational INF-T2-001, non-blocking) → [logs/working/task-2/infrastructure-reviewer-t2-round1.json](logs/working/task-2/infrastructure-reviewer-t2-round1.json)

*Round 2 (after fixes):*
- code-reviewer-t2: approved (no remaining findings) → [logs/working/task-2/code-reviewer-t2-round2.json](logs/working/task-2/code-reviewer-t2-round2.json)
- security-auditor-t2: PASS / APPROVE (no remaining findings) → [logs/working/task-2/security-auditor-t2-round2.json](logs/working/task-2/security-auditor-t2-round2.json)
- infrastructure-reviewer-t2: approved (no remaining findings) → [logs/working/task-2/infrastructure-reviewer-t2-round2.json](logs/working/task-2/infrastructure-reviewer-t2-round2.json)

**Verification:**
- `cd contracts && forge build` → exit 0 ("Nothing to compile")
- `cd contracts && npm run build` → exit 0 (forge no-op + tsx export-abi clean skip)
- `cd contracts && npx tsc --noEmit -p tsconfig.json` → exit 0
- `cd contracts && forge config` → exit 0; shows solc=0.8.20, optimizer=true, optimizer_runs=200
- `forge --version && anvil --version && cast --version` → all exit 0 (forge 1.6.0-nightly)
- `cd contracts/lib/openzeppelin-contracts && git describe --tags --exact-match` → v5.0.2
- root package.json `workspaces` includes `"contracts"` (T1 already set; T2 verified)
- `.gitignore` covers contracts/out/, contracts/cache/, contracts/broadcast/, contracts/.env, contracts/node_modules/ (T1 already set; T2 verified)
- Forbidden legacy env-var names (`ARC_TESTNET_RPC_URL`, `ARC_TESTNET_PRIVATE_KEY`) absent across `contracts/` (excluding `lib/` submodule)

**Open items for future tasks:**
- T3 (USDC EIP-3009 spike) will write `contracts/scripts/verify-usdc-eip3009.ts` and `arc-testnet-usdc-domain.json` here, consuming the viem devDep already in place.
- T4 (PaymentSplitterFactory.sol + PaymentVaultImpl.sol) consumes the OZ v5.0.2 submodule + remappings; once Solidity sources land, `npm run build` will populate `packages/middleware/src/abi/{PaymentSplitterFactory,PaymentVaultImpl}.json` automatically via the export-abi hook.
- T5 (Solidity tests) consumes forge-std v1.16.1 already installed under `lib/forge-std/`.
- T13 (security audit) will run `slither contracts/src/ --config-file contracts/slither.config.json` using the slither config written here.

## Task 3: Verify Arc Testnet USDC supports EIP-3009 + measure gas (spike)

**Status:** Done
**Commit:** bba2942 (impl) + 46600be (round-1 code-review fixes) + 3a9fbd3 (round-1 security-review fixes) + 75e0399 (round-1 test-review fixes)
**Agent:** usdc-spike
**Summary:** Wave 2 spike confirmed Arc Testnet USDC (`0x3600000000000000000000000000000000000000`, chain id `5042002`) exposes both `transferWithAuthorization` (selector `0xe3ee160e`) and `authorizationState`, returns `decimals=6` (per-payment fee math safe), and reports EIP-712 domain `{name: "USDC", version: "2"}` — note the chain returns the literal string `"USDC"` rather than the marketing-form `"USD Coin"` assumed in the task example; Task 6 must populate `NETWORKS['arc-testnet'].usdcEip712Name = "USDC"` verbatim or EIP-712 signatures will fail to verify. Measured per-payment gas cost `1212–1290 micro-USDC` (varies run-to-run with live `gasPrice`) which exceeds the 500 micro-USDC / 5%-of-0.01-USDC Risks-table threshold; the spike emits a non-blocking warning and exits 0 per spec. The artifact `contracts/scripts/arc-testnet-usdc-domain.json` is the sole handoff to Task 6 (Wave 5) and carries `notes[]` for module-load surfacing per iter-4 §5 T3.
**Deviations:** None from spec contract. Empirical surprise: chain reports `name="USDC"` (not `"USD Coin"`); recorded here so T6 picks up the correct value from the artifact rather than hardcoding the spec example.

**Spike measurements (literal artifact payload, last run):**
```json
{
  "name": "USDC",
  "version": "2",
  "decimals": 6,
  "supportsEip3009": true,
  "sampleGasCost": "1212 micro-USDC",
  "gasCostExceedsThreshold": true,
  "notes": [
    "gas estimation fallback applied: assumed 60000 gas (node refused estimate for reverting call)",
    "arc-dual-decimal: native gas is 18-decimal but ERC-20 view is 6"
  ]
}
```

**Per-payment economics at risk on high-volume APIs; defer batched-settlement to post-MVP `x402-batched-settlement` feature per Risks row 4** (gas cost > 5% of a 0.01 USDC payment; non-blocking for MVP per the same row's documented limitation).

**Reviews:**

*Round 1:*
- code-reviewer-t3: approved_with_minors (3 minor: EH-01 empty-catch comments, CF-01 nativeCurrency.name mismatch, DOC-01 decisions.md entry missing) → [logs/working/task-3/code-reviewer-t3-round1.json](logs/working/task-3/code-reviewer-t3-round1.json)
- security-auditor-t3: approve_with_notes (2 low: SEC-T3-01 / SEC-T3-02 RPC URL leakage via err.message in notes[] / stderr; 1 info: SEC-T3-INFO-01 no URL-scheme pre-validation) → [logs/working/task-3/security-auditor-t3-round1.json](logs/working/task-3/security-auditor-t3-round1.json)
- test-reviewer-t3: needs_improvement (0 critical/high, 2 medium: T3-M1 hard-blocker ordering, T3-M2 gas-unavailable sentinel; 3 low: T3-L1 probe note text, T3-L2 selector exit order [accepted], T3-L3 sanity-band comment) → [logs/working/task-3/test-reviewer-t3-round1.json](logs/working/task-3/test-reviewer-t3-round1.json)

*Round 2 (after fixes):*
- code-reviewer-t3: closed approved on round 1 (verbal confirmation after fix commit 46600be; no round-2 report file written by reviewer preference)
- security-auditor-t3: APPROVED — all round-1 findings resolved, no new issues → [logs/working/task-3/security-auditor-t3-round2.json](logs/working/task-3/security-auditor-t3-round2.json)
- test-reviewer-t3: passed (0 findings at any severity) — all round-1 mediums + lows resolved → [logs/working/task-3/test-reviewer-t3-round2.json](logs/working/task-3/test-reviewer-t3-round2.json)

**Verification:**
- `cd contracts && npx tsx scripts/verify-usdc-eip3009.ts` → exit 0; JSON output matches artifact byte-for-byte (same `out` object); deterministic shape across 3 consecutive runs.
- `cd contracts && npm run lint` (tsc --noEmit) → exit 0.
- gitleaks pre-commit hook → 0 leaks.
- Selector self-check `toFunctionSelector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)') === 0xe3ee160e` → pass.

**Open items for future tasks:**
- T6 (Wave 5, `networks.ts` author): consume `contracts/scripts/arc-testnet-usdc-domain.json` to populate `NETWORKS['arc-testnet'].usdcEip712Name = "USDC"` (NOT "USD Coin") and `usdcEip712Version = "2"`, and surface every `notes[]` entry at module load via warn-level log (informational only, never blocking).
- Post-MVP `x402-batched-settlement` feature: gas-cost spike (1212–1290 micro-USDC ≈ 12–13% of a 0.01 USDC payment) exceeds the 5% per-payment-economics threshold; defer batched-settlement work per Risks row 4. MVP per-payment settlement remains acceptable for low/mid-volume APIs per the same row's documented limitation.
- T6 must also document the gas estimation fallback (60000 gas constant) the artifact records — downstream callers should not assume the published gas cost is RPC-measured.

## Task 4: Factory + Vault contracts

**Status:** Done
**Commit:** 7aeab21 (impl) + ecdb025 (round-1 fixes) + 6663759 (round-2 fix)
**Agent:** contracts-author
**Summary:** Implemented the on-chain core of the x402 settlement flow per D3/D4/D8/D10–D17 and tech-spec Data Models. `PaymentSplitterFactory` (Ownable2Step + Pausable) deploys per-developer USDC vaults as EIP-1167 minimal proxies via `Clones.cloneDeterministic` with `salt = bytes32(uint256(uint160(msg.sender)))` so off-chain middleware can predict the `payTo` address. `PaymentVaultImpl` (Initializable + storage-based ReentrancyGuard) is a passive USDC receiver with split-on-withdraw — developer first, platform second per systemic-fix §7 — and is intentionally unpausable (D12). `IERC3009` interface defines the off-chain ABI helper consumed by middleware; `MockUsdcEip3009` (under `test/mocks/`, not `src/`) implements EIP-3009 with Circle FiatTokenV2_2 EIP-712 domain (`name = "USD Coin"`, `version = "2"`, decimals 6) for Foundry tests. Custom errors (`NotDeveloper`, `NoBalance`, `ZeroAddress`, `AlreadyRegistered`, `InvalidFeeBps`) used throughout for gas efficiency and test-selector matching. Constructor takes exactly 3 args `(usdc, platformTreasury, initialFeeBps)`; `vaultImpl` is deployed inside the constructor and immutable.
**Deviations:** None from spec — event signatures (`VaultDeployed`, `FeeBpsUpdated`, `PlatformTreasuryUpdated`, `Withdrawal`) match tech-spec Data Models exactly after round 1. Note: `PlatformTreasuryUpdated` uses parameter names `oldTreasury/newTreasury` (more descriptive than spec's `oldTo/newTo`) — ABI-compatible per security-auditor confirmation.

**Reviews:**

*Round 1:*
- code-reviewer-t4: request_changes (2 major event-indexing deviations, 4 minor) → [logs/working/task-4/code-reviewer-t4-round1.json](logs/working/task-4/code-reviewer-t4-round1.json)
- security-auditor-t4: PASS_WITH_NOTES (1 medium operator-DoS doc, 3 low, 3 info) → [logs/working/task-4/security-auditor-t4-round1.json](logs/working/task-4/security-auditor-t4-round1.json)
- test-reviewer-t4: needs_improvement (2 medium, 3 low) → [logs/working/task-4/test-reviewer-t4-round1.json](logs/working/task-4/test-reviewer-t4-round1.json)

*Round 2 (after fixes):*
- code-reviewer-t4: approved_with_minor_notes (1 minor — comment constants imprecision T4-R2-01) → [logs/working/task-4/code-reviewer-t4-round2.json](logs/working/task-4/code-reviewer-t4-round2.json)
- security-auditor-t4: PASS (all round-1 findings resolved; SA-T4-03 retracted as false positive on author pushback) → [logs/working/task-4/security-auditor-t4-round2.json](logs/working/task-4/security-auditor-t4-round2.json)
- test-reviewer-t4: passed (T4-TRV1-002 retracted on author pushback — current `<= validAfter` matches Circle's `require(now > validAfter)`) → [logs/working/task-4/test-reviewer-t4-round2.json](logs/working/task-4/test-reviewer-t4-round2.json)

*Round 3 (after T4-R2-01 fix):*
- code-reviewer-t4: approved (final) → [logs/working/task-4/code-reviewer-t4-round3.json](logs/working/task-4/code-reviewer-t4-round3.json)

**Verification:**
- `cd contracts && forge build` → exit 0, no warnings (27 files compiled with solc 0.8.20).
- D15 grep checks on `src/PaymentVaultImpl.sol` (selfdestruct/delegatecall/assembly executable lines) → empty.
- D16/D17 grep (receive/fallback/setDeveloper/setFactory) → empty.
- `@custom:security-invariant no_selfdestruct no_delegatecall single_initializer no_setters_for_developer_or_factory` NatSpec confirmed on `PaymentVaultImpl` (anchor for T13 security audit).
- gitleaks pre-commit hook → 0 leaks.

**Open items for future tasks:**
- T5 (Wave 3 contract tests, Foundry): implement the 16 TDD anchors listed in `tasks/4.md` lines 96–114; both `ZeroAddress` errors (defined in factory AND vault) must be qualified by contract in `vm.expectRevert(PaymentSplitterFactory.ZeroAddress.selector)` vs `PaymentVaultImpl.ZeroAddress.selector`. Add the security-auditor's suggested coverage: `MockRevertingTreasury` to verify withdraw DoSes (SA-T4-01) and `feeBps=0` workaround test.
- T6 (Wave 5 middleware `networks.ts`): use `Clones.predictDeterministicAddress` math equivalent in JS — salt is `bytes32(uint256(uint160(developer)))` (left-padded address), deployer is factory address. Match the on-chain formula exactly or off-chain `payTo` will diverge.
- Pre-deploy wave: README operational guide must document treasury-DoS risk (SA-T4-01) — `platformTreasury` MUST be plain EOA or audited multisig, never a contract with custom token-receive logic. Currently documented in `PaymentVaultImpl.withdraw()` NatSpec only.

## Task 5: Contract tests (Foundry)

**Status:** Done
**Commits:** 3cf5f71 (impl) + c4c6d3a (code-review round 1 fixes) + aa5b404 (test-reviewer advisories) + f346c67 (security-auditor SA-T5-02 fix)
**Agent:** contract-tester
**Summary:** Wrote the full Foundry test suite for `PaymentSplitterFactory` and `PaymentVaultImpl`: 29 unit + 1 fuzz tests in `PaymentSplitterFactory.t.sol`, 20 unit + 1 fuzz tests in `PaymentVaultImpl.t.sol`, and 3 handler-based stateful invariants in `invariants/VaultInvariants.t.sol`, all built on `forge-std/Test.sol` with OZ v5 selectors for custom errors. Added two new mocks under `test/mocks/`: `MockMaliciousTreasury.sol` (re-enters `vault.withdraw()` via USDC receiver hook) and `MockUsdcWithHook.sol` (test-only ERC20 with `_update` callback used solely by the dynamic reentrancy test). All factory deploys use the canonical 3-arg constructor `(usdc, treasury, feeBps)` per iteration-3 §1. CREATE2 invariant test cross-checks `factory.computeVaultAddress` against OZ `Clones.predictDeterministicAddress` directly in Solidity for 3 EOAs (addendum §4 T5).
**Deviations:** Added `MockUsdcWithHook.sol` as a separate mock rather than retrofitting `MockUsdcEip3009.sol` (which has no callback hook — Task 4 did not implement one). Task spec explicitly permitted either path; this keeps the EIP-3009 mock fixed-purpose and isolates the test-only hook semantics. The hook fires unconditionally (no `try/catch`) by design — the test relies on the inner `ReentrancyGuardReentrantCall` revert propagating through `_update` back to the outer `withdraw()`. SA-T5-01 (TransferOrderRecorder mock for direct developer-first ordering assertion) deferred — order is NatSpec-documented and indirectly proved by the malicious-treasury reentrancy test; auditor explicitly marked as non-blocking.

**Reviews:**

*Round 1:*
- code-reviewer-t5: approve_with_minor_findings (R1-01 fuzz threshold, R1-02 informational, R1-03 reentryCount-observability claim [later retracted], R1-04 handler comment) → [logs/working/task-5/code-reviewer-t5-round1.json](logs/working/task-5/code-reviewer-t5-round1.json)
- security-auditor-t5: APPROVE_WITH_NOTES (SA-T5-01 transfer order recorder LOW, SA-T5-02 missing test_Unpause_OwnerOnly LOW, SA-T5-03 INFO) → [logs/working/task-5/security-auditor-t5-round1.json](logs/working/task-5/security-auditor-t5-round1.json)
- test-reviewer-t5: APPROVED (T5-R1-01 event-mirror comment, T5-R1-02 handler pause-exclusion comment, T5-R1-03 confirmed sound) → [logs/working/task-5/test-reviewer-t5-round1.json](logs/working/task-5/test-reviewer-t5-round1.json)

*Round 2:*
- code-reviewer-t5: APPROVED — R1-01 + R1-04 fixed; R1-03 retracted on reviewer pushback after empirical verification (adding `assertEq(malicious.reentryCount(), 1)` after the expectRevert block fails with `0 != 1`, confirming cross-contract state writes inside the reverting call tree roll back) → [logs/working/task-5/code-reviewer-t5-round2.json](logs/working/task-5/code-reviewer-t5-round2.json)
- security-auditor-t5 + test-reviewer-t5: no round-2 review file written (advisories accepted, original verdict stands)

**Verification:**
- `cd contracts && forge test` → 52 passed, 0 failed (29 factory + 20 vault + 3 invariant suites).
- `cd contracts && forge coverage --report summary --ir-minimum` → `src/PaymentSplitterFactory.sol` **100% branches (6/6)**, `src/PaymentVaultImpl.sol` **100% branches (4/4)** — exceeds the 95% acceptance threshold on both.
- `cd contracts && forge coverage --report lcov --ir-minimum` writes `contracts/lcov.info` (gitignored).
- Sanity: `grep -rn "new PaymentSplitterFactory" contracts/test/**/*.t.sol` → only 3-argument deploys `(usdc, treasury, feeBps)`. No 4-arg legacy form.
- Sanity: imports in `.t.sol` files are forge-std + OZ + local only — no hardhat/chai/mocha/ethers/viem.
- gitleaks pre-commit hook → 0 leaks across all four commits.

**Open items for future tasks:**
- T10 (Wave 6 forked-e2e): the unit suite proves split math and reentrancy guard; forked-e2e should re-exercise the happy path against real Arc Testnet USDC (`0x3600000000000000000000000000000000000000`) to verify the EIP-3009 settlement path lands USDC into the vault and the withdraw split works against the production token contract.
- T13 (security audit, Wave 7): the Foundry suite covers all 12 custom error selectors and the D15/D16/D17 invariants; auditor input may flag SA-T5-01 (TransferOrderRecorder mock) as a prereq for direct developer-first ordering assertion. Deferred from T5 with auditor concurrence.
- CI workflow (separate task): the lcov-threshold check the addendum §4 T5 anticipates should grep `BRH:`/`BRF:` in `contracts/lcov.info` for `src/PaymentSplitterFactory.sol` and `src/PaymentVaultImpl.sol` against a 95% gate. Concrete grep command not written here per task-5 scope.
