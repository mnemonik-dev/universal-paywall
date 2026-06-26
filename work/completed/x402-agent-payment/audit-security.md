# Security Audit — x402-agent-payment (T13)

**Auditor:** security-auditor
**Wave:** 10 (Audit Wave)
**Scope:** middleware (`packages/middleware/src/`), contracts (`contracts/src/`), CLI (`scripts/register.ts`), deploy script (`contracts/script/Deploy.s.sol` + `contracts/scripts/post-deploy.ts`), USDC spike (`contracts/scripts/verify-usdc-eip3009.ts`).
**Report companion:** [logs/working/audit/security-auditor.json](logs/working/audit/security-auditor.json) — machine-readable form of the same findings.

---

## Executive Summary

The final state of the x402-agent-payment implementation honours every D1–D18 invariant from the tech-spec. No critical or high findings. One medium (a defense-in-depth gap in the `scrubSecrets` bare-64-hex regex that does not match any current code path), four low (mostly off-chain event indexing and operator-observability concerns), and nine informational findings (Slither false positives, anvil default-key documentation, and minor auditability suggestions). All security-tagged test suites pass: 253 middleware vitest tests (2 integration skipped), 52 Foundry tests, and the reentrancy-specific subset. Slither reports 4 findings, all triaged to informational against D3/D4/D11. Gitleaks reports one finding which is the documented, universally-public anvil pre-funded account-0 key. **Implementation is CLEARED to advance to the Final Wave.**

**Counts:** Critical 0 · High 0 · Medium 1 · Low 4 · Informational 9.

---

## D1–D18 Coverage Matrix

| #   | Decision                                                | Scope                     | Verdict     | Notes |
|-----|---------------------------------------------------------|---------------------------|-------------|-------|
| D1  | Strict x402 v1 wire format                              | IN-SCOPE                  | PASS        | x402.ts decode enforces 4KB cap via `Buffer.byteLength`, exact-keys validation, strict hex regex, decimal-int regex. Errors carry typed phase; no echo of attacker bytes in HTTP body. 43 unit tests. |
| D2  | EIP-3009 `transferWithAuthorization`, explicit `from`   | IN-SCOPE                  | PASS        | settle.ts:375 passes `authorization.from` as the `from` arg. EIP-712 ecrecover gate enforces `recovered == authorization.from` before settle is reachable. |
| D3  | Per-developer vault via EIP-1167 + CREATE2              | IN-SCOPE                  | PASS        | `salt = bytes32(uint256(uint160(msg.sender)))`. `AlreadyRegistered` on second call. `computeVaultAddress` cross-checked against `Clones.predictDeterministicAddress` via `test_Register_PredictedAddressMatchesClonesPredict`. `vaultImpl` immutable. |
| D4  | Vault holds gross, fee split at withdraw                | OUT-OF-SECURITY-SCOPE     | NOTE-ONLY   | Fee-math is T12. Security check: developer-first/platform-second order + nonReentrant — confirmed. |
| D5  | Two-layer replay (NonceStore + on-chain authorizationState) | IN-SCOPE              | PASS        | `checkAndInsert` runs has + insert as one synchronous block (no `await`). settle.ts never touches NonceStore — structural retention-on-failure. |
| D6  | Framework-agnostic core + adapters                      | OUT-OF-SECURITY-SCOPE     | NOTE-ONLY   | Architectural. Security check: adapters never see raw key — `OpaqueRelayerKey` wrapper passes through opaque. |
| D7  | viem 2.x for EVM interaction                            | IN-SCOPE                  | PASS        | `recoverTypedDataAddress` is the sole ecrecover. No ethers/web3 imports in production src. |
| D8  | Solidity ^0.8.20 + OZ 5.x + storage-based ReentrancyGuard | IN-SCOPE                | PASS        | Pragmas + imports verified. NatSpec note documents EIP-1167 clone storage-init nuance (`_status` starts at 0, transitions to ENTERED=2 then NOT_ENTERED=1). |
| D9  | Foundry toolchain (forge + anvil)                       | OUT-OF-SECURITY-SCOPE     | NOTE-ONLY   | Tooling. Security check: `slither.config.json` `filter_paths: 'test/,lib/'` correctly excludes mocks + OZ from production-security severity. |
| D10 | Configurable platform fee, 0–1000 bps, owner-only       | OUT-OF-SECURITY-SCOPE     | NOTE-ONLY   | Policy. Security check: `setFeeBps` is `onlyOwner` and reverts `InvalidFeeBps` above 1000 bps. Tests pass. |
| D11 | platformTreasury settable, separate from owner          | IN-SCOPE                  | PASS        | `setPlatformTreasury` is `onlyOwner`, rejects `address(0)`, emits event. Treasury is a distinct storage slot from owner. (See L-CT-01: event lacks indexed param — non-blocking.) |
| D12 | Pausable off-chain checked by middleware                | IN-SCOPE                  | PASS        | Factory `Pausable`; `register()` blocked when paused; `vault.withdraw()` INTENTIONALLY NOT paused (`test_Withdraw_WorksWhenFactoryPaused`). 5s middleware cache with stale-fail-closed rpc_5xx surfacing. |
| D13 | `OpaqueRelayerKey` opaque non-enumerable wrapper        | IN-SCOPE                  | PASS        | Module-private `WeakMap` (stronger than `#private`). `toJSON`/`toString`/`[util.inspect.custom]` all redact. scrubSecrets covers all four shapes (with caveat M-MW-01). settle.ts is the sole extractor. 24 relayer-key tests. |
| D14 | Startup chainId pin + rpcUrl trust                      | IN-SCOPE                  | PASS        | Per-network first-use `publicClient.getChainId()` assertion in settle.ts. Throws `NetworkMismatchError` before any settle path. `facilitator.rpcUrl` override is documented in code. |
| D15 | `_disableInitializers()` + no destructive primitives    | IN-SCOPE                  | PASS        | Constructor calls `_disableInitializers()`. NatSpec invariant `no_selfdestruct no_delegatecall single_initializer`. Grep sweep: 0 hits for `selfdestruct`/`delegatecall`/`assembly` in `contracts/src/`. Slither confirms. `test_D15_DirectInitializeOnImplReverts` passes. |
| D16 | No `receive()` / `fallback()` on vault                  | IN-SCOPE                  | PASS        | Grep + manual read confirm absence. `test_D16_NativeTransferReverts` asserts native `call{value:1}` returns false. EIP-1167 clone forwards to impl — impl has no receive/fallback. |
| D17 | No setters for `developer` / `factory`                  | IN-SCOPE                  | PASS        | Grep returns zero hits for `setDeveloper`/`setFactory`. `initializer` modifier on `initialize()` enforces single-write. ABI-assertion tests pass. |
| D18 | Structured security logging (typed catalog)             | IN-SCOPE                  | PASS        | 14 typed events. core.ts `emit()` is fire-and-forget, try/catch wrapped, scrubSecrets-applied with `SAFE_HEX_FIELDS=['txHash']` carve-out. Hash helpers return canonical 10-char `'0x'+keccak256(input).slice(2,10)`. No raw addresses/signatures/nonces in any payload — type-system-enforced via SecurityEventCatalog. |

---

## Risks-Row Coverage

| Risk                                                | Verdict          | Evidence |
|-----------------------------------------------------|------------------|----------|
| Replay-store mid-failure delete vs not              | PASS             | settle.ts has zero NonceStore imports — structural enforcement. |
| Settlement failure mid-flight                       | PASS             | Retry surfaces `nonce_already_used` (verify.ts:189). |
| Per-payment gas economics                           | NOTE-ONLY        | T3 artifact shows >5% gas/payment ratio. Documented limitation; not a security defect. |
| Arc Testnet USDC doesn't expose transferWithAuthorization | PASS        | T3 spike artifact confirms `supportsEip3009=true`; networks.ts refuses to boot with stub values. |
| Treasury DoS via misconfigured platformTreasury     | PASS (operator-doc) | NatSpec PaymentVaultImpl.sol:73-78 documents the constraint. Funds are frozen, not lost. |
| Single-relayer-per-process assumption                | NOTE-ONLY        | settle.ts WALLET_CACHE keyed on network.id; second key silently ignored. Documented (decisions.md T7). |
| Multi-instance NonceStore (Redis-backed)            | NOTE-ONLY        | replay-store.ts:4-5 documents single-process scope. Post-MVP. |

---

## Middleware Findings

### Critical
None.

### High
None.

### Medium

#### M-MW-01 — scrubSecrets does NOT redact bare-64-hex inside a longer hex run
- **Location:** `packages/middleware/src/relayer-key.ts:32` (`HEX_64_BARE_RE`)
- **Anchor:** D13
- **Description:** `\b[0-9a-fA-F]{64}\b` uses word boundaries; hex chars are word chars, so a 128-char hex run has no word boundary at the 64/65 split. A concatenated `${key1}${key2}` or a bare-130-hex signature (no `0x` prefix) slips past the redactor. The `0x+64` and `0x+130` patterns require a literal `0x` and won't catch the bare form either.
- **Attack scenario:** A future maintainer writes `logger.info('replay ' + payerAddrNoPrefix + nonceNoPrefix)` — 40+64 = 104-char hex run with no word boundary internally. The 64-hex section is not at a word boundary; redactor misses it. Defense-in-depth gap; no current code path concatenates raw hex this way.
- **Recommendation:** Replace `\b...\b` with lookarounds: `(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])`. Add a bare-130 pattern. Add fuzz strings to relayer-key.test.ts.
- **Blocks Final Wave:** No (defense-in-depth, no exploited path today).

### Low

#### L-MW-01 — register CLI holds the raw key as a `Hex` variable in `run()` scope
- **Location:** `scripts/register.ts:227-228`
- **Anchor:** D13
- **Description:** The raw key is bound to `const secret` until used on the next line. The window is small (one line), and the catch path uses `classifyError` which scrubs.
- **Recommendation:** Inline: `const account = privateKeyToAccount(getRelayerKeySecret(opaque) as Hex)`.
- **Blocks Final Wave:** No.

#### L-MW-02 — relayer_low_balance signals an exploitable timing window if forwarded to public channels
- **Location:** `packages/middleware/src/settle.ts:343`, `core.ts:603-609`
- **Anchor:** D18
- **Description:** The event payload contains the raw balance string. An external observer learning "relayer balance just dropped below 1 USDC" can time DoS.
- **Recommendation:** Bucket the field (`critical | low | sufficient`) or document operator-only consumption.
- **Blocks Final Wave:** No.

### Informational

#### I-MW-01 — settle.ts passes `authorization.from` (not `recoveredFrom`) to USDC
- **Location:** `packages/middleware/src/settle.ts:376`, `core.ts:580`
- **Anchor:** D2
- **Description:** Functionally equivalent (verify enforces `recovered == authorization.from`). Auditability suggestion only.
- **Recommendation:** Change `args: [authorization.from, ...]` to `args: [recoveredFrom, ...]`.

#### I-MW-02 — `network_mismatch` event payload logs raw `payload.network`
- **Location:** `packages/middleware/src/core.ts:551`
- **Anchor:** D18
- **Description:** Attacker-controlled string in logger payload; not echoed in HTTP body. scrubSecrets strips any hex shapes. 4KB header cap bounds size.
- **Recommendation:** Optional truncation to a short display length for log hygiene.

#### I-MW-03 — `header_too_large` hint carries attacker byte count (internal-only)
- **Location:** `packages/middleware/src/x402.ts:144-147`
- **Anchor:** D1
- **Description:** Hint never crosses to HTTP response body; numeric size field is safe.
- **Recommendation:** None.

#### I-MW-04 — `insert()` is test-only and lacks lazy TTL eviction (by design)
- **Location:** `packages/middleware/src/replay-store.ts:91-104`
- **Anchor:** D5
- **Description:** Documented; no production caller.
- **Recommendation:** None.

#### I-MW-05 — `X-PAYMENT-RESPONSE` exposes tx hash + payer to caller (spec-required)
- **Location:** `packages/middleware/src/core.ts:620-625`
- **Anchor:** D1
- **Description:** x402 v1 spec-mandated. tx hash is public on-chain; payer is the agent's own address.
- **Recommendation:** None.

#### I-SCRIPT-01 — Gitleaks: anvil default account-0 key in task spec
- **Location:** `work/x402-agent-payment/tasks/11.md:183`
- **Anchor:** D13
- **Description:** Universally-public anvil pre-funded private key, inline-documented as such.
- **Recommendation:** Add to `.gitleaksignore` to silence the husky pre-commit false-positive on future commits.

---

## Contract Findings

### Critical
None.

### High
None.

### Medium
None.

### Low

#### L-CT-01 — `PlatformTreasuryUpdated` event has no indexed parameters
- **Location:** `contracts/src/PaymentSplitterFactory.sol:33`
- **Anchor:** D11
- **Description:** Off-chain log filterability concern; not exploitable.
- **Recommendation:** Add `indexed` on `newTreasury`. Non-blocking.

#### L-CT-02 — `VaultDeployed` lacks `indexed` on `vault`
- **Location:** `contracts/src/PaymentSplitterFactory.sol:31`
- **Anchor:** D3
- **Description:** Same off-chain filterability concern.
- **Recommendation:** Add `indexed` on the `vault` parameter.

### Informational

#### I-CT-01 — Slither `incorrect-equality` on `gross == 0` (false positive)
- **Location:** `contracts/src/PaymentVaultImpl.sol:87`
- **Anchor:** D4
- **Description:** Canonical empty-balance check; no rebase/oracle dependence.
- **Recommendation:** None.

#### I-CT-02 — Slither `reentrancy-events` on `register()` (informational against D3)
- **Location:** `contracts/src/PaymentSplitterFactory.sol:61-71`
- **Anchor:** D3
- **Description:** External call is to a freshly-cloned proxy delegating to our immutable `vaultImpl` (no callback surface). State write precedes call. Any reentrant `register()` would hit `AlreadyRegistered`.
- **Recommendation:** Optional `nonReentrant` for belt-and-suspenders. Non-blocking.

#### I-CT-03 — Slither `naming-convention` on `_developer`
- **Location:** `contracts/src/PaymentVaultImpl.sol:60`
- **Anchor:** none
- **Description:** Convention choice; not a security concern.
- **Recommendation:** None.

---

## Tooling Appendix

### Middleware tests
**Command:** `npm test --workspace=@universal-paywall/middleware`
**Result:** Exit 0 · 14 files · 253 passed · 2 skipped (Arc Testnet E2E gated) · 0 failed.

Security-tagged subsets all green:
- `relayer-key.test.ts` (24 tests) — pino, winston, structuredClone, util.inspect, console.log, JSON.stringify, scrubSecrets 4-pattern, cycle/DAG.
- `replay-store.test.ts` (9 tests) — TOCTOU, retention-on-failure, capacity eviction.
- `verify.test.ts` (18 tests) — EIP-712 tamper (chainId/verifyingContract/name/version), 5s safety margin, network_mismatch, to_mismatch, BigInt value compare.
- `settle.test.ts` (23 tests) — chainId pin first-use, parseSignature v-fallback, classifier seven-way, relayer_no_balance proactive check.
- `core.test.ts` (50 tests) — SecurityLogger payload shapes, txHash preservation, scrubSecrets at boundary, stale-fail-closed.

### Foundry tests
**Command:** `cd contracts && forge test`
**Result:** Exit 0 · 3 suites · 52 passed · 0 failed.

Security-tagged tests confirmed:
- `test_D15_DirectInitializeOnImplReverts` — Initializable.InvalidInitialization on direct impl call.
- `test_D16_NativeTransferReverts` — native ETH `call{value:1}` returns false.
- `test_D17_NoSetDeveloperSelector` / `test_D17_NoSetFactorySelector` — selector-by-hash ABI assertions.
- `test_Register_PredictedAddressMatchesClonesPredict` — CREATE2 off-chain/on-chain byte-for-byte equality.
- `test_Withdraw_ReentrancyBlocked_ViaMaliciousTreasury` — `ReentrancyGuardReentrantCall` on re-entry through fee transfer.
- `test_Ownable2Step_TransferRequiresAccept` / `AcceptCompletesTransfer` / `CancelByNewTransfer`.
- `test_Withdraw_WorksWhenFactoryPaused` (D12 — withdraw intentionally unpaused).

### Reentrancy-specific subset
**Command:** `cd contracts && forge test --match-test Reentrancy`
**Result:** Exit 0 · 1 passed (`test_Withdraw_ReentrancyBlocked_ViaMaliciousTreasury`).
Note: `--match-contract Reentrancy` returned "no tests found" because the reentrancy test lives inside `PaymentVaultImplTest` (not a separate contract); `--match-test Reentrancy` is the correct selector.

### Slither
**Command:** `cd contracts && slither src/ --config-file slither.config.json`
**Version:** 0.11.5
**Result:** 4 findings (15 contracts analyzed, 101 detectors).

| Detector              | File                              | Line | Triage |
|-----------------------|-----------------------------------|------|--------|
| incorrect-equality    | PaymentVaultImpl.sol              | 87   | INFORMATIONAL — canonical empty-balance check (I-CT-01). |
| reentrancy-events     | PaymentSplitterFactory.sol        | 61-71 | INFORMATIONAL — CEI + immutable vaultImpl (I-CT-02). |
| naming-convention     | PaymentVaultImpl.sol              | 60   | INFORMATIONAL — convention choice (I-CT-03). |
| unindexed-event-address | PaymentSplitterFactory.sol      | 33   | LOW — log filterability (L-CT-01). |

### Gitleaks
**Command:** `gitleaks detect --no-banner --redact`
**Version:** 8.30.1
**Result:** 1 finding — anvil default key in `tasks/11.md:183` (documented as public). Recommendation: `.gitleaksignore` entry.

### Grep sweep
**Commands & results (all in `contracts/src/`):**
- `grep -rn 'selfdestruct\|delegatecall' contracts/src/` → 0 production hits (one NatSpec invariant string on PaymentVaultImpl.sol:26).
- `grep -rn 'assembly' contracts/src/` → 0 hits.
- `grep -rn 'tx.origin' contracts/src/` → 0 hits.
- `grep -rn 'receive\|fallback' contracts/src/` → 0 function hits (only docstring mentions of the word "receive").
- `grep -rn 'setDeveloper\|setFactory' contracts/src/` → 0 hits.

### Coverage (READ, not re-run; threshold-gating routed to T14)
- `contracts/lcov.info` (from T5's `forge coverage --report lcov`):
  - `PaymentSplitterFactory.sol`: BRH=6 / BRF=6 (100% branches).
  - `PaymentVaultImpl.sol`: BRH=4 / BRF=4 (100% branches).
  - All security-tagged branches exercised.
- `packages/middleware/coverage/index.html` (from T9's vitest `--coverage`):
  - Statements 96.87% · Branches 89.18% · Functions 100% · Lines 96.87%.
  - Above the 95% statement / 85% branch target. Security-tagged branches exercised.

---

## Sign-off

| Field                            | Value |
|----------------------------------|-------|
| Critical findings                | **0** |
| High findings                    | **0** |
| Medium findings                  | 1 (M-MW-01, non-blocking defense-in-depth) |
| Low findings                     | 4 |
| Informational findings           | 9 |
| Blocking findings                | **0** |
| Final Wave verdict               | **CLEAR TO ADVANCE** |
| Auditor                          | security-auditor |
| Date                             | 2026-06-17 |

Every D1–D18 invariant is honoured by the FINAL STATE code. Every middleware audit item in the task description has an explicit verdict with file/line evidence. Every contract audit item has an explicit verdict. All security-tagged tests pass. Slither's 4 findings triage to informational/low against D3/D4/D11 anchors. Gitleaks's single finding is the canonical public anvil default key. The lone MEDIUM finding (M-MW-01) is a defense-in-depth regex tightening with no exploited code path today and is recommended (not required) before Final Wave. **Implementation is cleared to advance to the Final Wave.**
