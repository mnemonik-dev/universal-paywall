# Code Audit — x402-agent-payment

**Auditor:** code-auditor (Task 12, Audit Wave)
**Commit at audit:** `61225621`
**Scope:** Holistic code-quality audit across `packages/middleware/src/` (12 .ts), `contracts/src/` (3 .sol), `contracts/script/Deploy.s.sol`, `contracts/scripts/{post-deploy.ts, verify-usdc-eip3009.ts, export-abi.ts}`, `scripts/register.ts`.

Companion JSON report (consumed by lead): [logs/working/audit/code-auditor.json](logs/working/audit/code-auditor.json).

## Summary

Feature is structurally sound and ready to ship pending Minor cleanup. The two highest-signal observations are (1) `packages/middleware/src/errors.ts` is a dead parallel implementation — exported but not consumed by `core.ts`, with a divergent body shape (`settlementReason` field vs `core.ts`'s `reason` field) that the vendored x402 schema only tolerates because it accommodates both; (2) the seven settlement sub-reasons are typed twice with non-identical names (`SettleReason` in settle.ts, `SettlementSubReason` in errors.ts), inviting drift. Cross-adapter (`node-http`, `fastify`) parity is intact for the documented contract; all D1–D18 code-constraining invariants are honored. Recommended next step: lead bundles Minor + Nit findings into a single fixer pass before T16 deploy.

## Findings by severity

### Blocker
None.

### Major
None.

### Minor

#### T12-01 — `errors.ts` is structurally dead and emits a divergent body shape
**File:** `packages/middleware/src/errors.ts` (lines 1–99)
**Dimension:** Separation of Concerns / Cross-File Consistency

`errors.ts` defines `buildErrorResponse(reason, ctx)` returning a body with field name `settlementReason`. No production source file imports from `errors.ts` (verified: `grep -rn "from './errors'" packages/middleware/src --exclude-dir=__tests__` → zero hits; `index.ts` does not re-export it). All 402 responses on the wire are built by `core.ts`'s private `build402(...)` helper, which uses the field name `reason` (e.g. line 423: `build402(402, null, 'settlement_failed', { reason: 'internal_error' })`). The vendored x402 v1 JSON Schema at `__tests__/fixtures/x402-v1.schema.json` (lines 109–110) permits BOTH field names, which is the only reason the divergence is invisible today.

Practical impact: two parallel response-builder implementations to keep in sync; the unit tests for `errors.ts` assert a shape no production response actually emits; a future maintainer will reasonably mistake `buildErrorResponse` for the canonical builder.

**Fix:** Pick one path. Either (a) delete `errors.ts`, move its three constant tables (`REASONS_400`, `ErrorReason`, `SettlementSubReason`) into a tiny shared `error-reasons.ts` consumed by `core.ts`, and rewrite `errors.test.ts` against `core.ts`'s response shape; OR (b) make `errors.ts` the canonical builder, refactor `core.ts` to call `buildErrorResponse(...)` for every 402, and standardize on `settlementReason` as the body field name. Option (a) is simpler given `core.ts` already does the work. Either way the `reason` vs `settlementReason` drift must end.

#### T12-02 — Settlement sub-reason taxonomy declared twice (`SettlementSubReason` vs `SettleReason`)
**Files:** `packages/middleware/src/errors.ts:40-47` and `packages/middleware/src/settle.ts:65-72`
**Dimension:** Type Safety / Cross-File Consistency

Both modules declare a string-literal union of the same seven settlement reasons under different names. If a future change adds an eighth reason to one but not the other, the unions silently diverge. `core.ts:610` builds the response body with `reason: settleResult.reason` (typed as `string` literal at the call site), so neither union would catch the drift at compile time.

**Fix:** Delete `SettlementSubReason` from `errors.ts`. If T12-01 keeps `errors.ts` alive, have it `import type { SettleReason } from './settle.js'` and replace every `SettlementSubReason` with `SettleReason`. If T12-01 deletes `errors.ts`, `SettleReason` in settle.ts becomes the single source of truth automatically.

#### T12-03 — `reason: 'internal_error'` literal is not in any settlement-reason taxonomy
**File:** `packages/middleware/src/core.ts` (lines 423, 592)
**Dimension:** Type Safety / Error Handling

core.ts emits `build402(402, ..., 'settlement_failed', { reason: 'internal_error' })` on two paths: (1) unknown `opts.network` (line 423), and (2) `NetworkMismatchError` from settleOnChain (line 592). `internal_error` is NOT a member of `SettleReason` (settle.ts:65–72) nor `SettlementSubReason` (errors.ts:40–47) nor the documented D5 taxonomy. Any downstream consumer pattern-matching on the seven documented reasons will silently fail to handle these two cases.

**Fix:** Either add `'internal_error'` to `SettleReason` and re-document D5 as eight reasons, OR change the two emit sites to use a documented bucket. Cleanest is introducing `chain_id_mismatch` as a settlement sub-reason (it is already its own D18 event name, so the rename is local). The literal `internal_error` should not appear on the wire.

#### T12-04 — `relayer-key.ts` docstring describes the abandoned `#key` private-field design
**File:** `packages/middleware/src/relayer-key.ts` (lines 2–22)
**Dimension:** Code Readability & Maintainability

The header docstring (lines 5, 14) says "Secret lives in a class-private `#key` field." The actual implementation (after T6 round-1 hardening) is stronger: the secret lives in a module-private `WeakMap<OpaqueRelayerKey, string>` at line 39, and the class carries only a brand marker. The class has NO `#key` field. A reader following the docstring expects a `#key` in the class body and finds none.

**Fix:** Rewrite lines 5–6 to: `- Secret lives in a module-private WeakMap<OpaqueRelayerKey, string> (line 39), reachable only via getRelayerKeySecret(key) — strictly stronger than a class-private #key because no class member, public or otherwise, can extract the secret.` Drop the `Object.keys` / `JSON.stringify` / `Object.getOwnPropertyNames` claims about a non-existent class field.

#### T12-05 — Local variables `usdc` and `feeBps` in `PaymentVaultImpl.withdraw()` shadow interface method names
**File:** `contracts/src/PaymentVaultImpl.sol` (lines 84, 89)
**Dimension:** Code Readability

Inside `withdraw()`, line 84 `IERC20 usdc = IERC20(f.usdc());` shadows `IPaymentSplitterFactory.usdc()` (declared at line 14), and line 89 `uint256 feeBps = f.feeBps();` shadows `IPaymentSplitterFactory.feeBps()` (line 15). Solidity 0.8.20 does not warn (different scopes), but in a 19-line function that already juggles `f.usdc()`, `gross`, `fee`, `net`, the readability cost is non-zero.

**Fix:** Rename the locals to `usdcToken` and `currentFeeBps` (or `bps`). Two-line diff, no semantic change, no ABI change.

### Nit

#### T12-06 — Verify-result switch in `core.ts` has no exhaustiveness guard
**File:** `packages/middleware/src/core.ts` (lines 534–567)
**Dimension:** Code Readability

The `switch (reason)` over `VerifyReason` covers all seven current cases but has no `default:` clause and no `const _exhaust: never = reason` guard. A future eighth reason added to verify.ts would fall through to settle code at line 570; the destructure `const { recoveredFrom } = verifyResult;` (line 576) does catch this via narrowing, but the error surfaces away from the switch.

**Fix:** Add `default: { const _: never = reason; throw new Error('unreachable'); }` at line 568.

#### T12-07 — `Content-Type` header capitalization and charset drift
**Files:** `core.ts:333`, `adapters/node-http.ts:30`, `errors.ts:95`
**Dimension:** Code Readability / Cross-File Consistency

Three response paths emit Content-Type with three shapes: `core.ts` writes `Content-Type: application/json` (no charset); `node-http.ts` writes the same name then redundantly spreads `result.headers`; `errors.ts` writes `content-type: application/json; charset=utf-8`. HTTP header names are case-insensitive so this is wire-equivalent, but the drift fights future grep.

**Fix:** Standardize on `'Content-Type': 'application/json; charset=utf-8'` at `core.ts:333`; remove the redundant header in `node-http.ts:30` (let `result.headers` carry it). If T12-01 deletes `errors.ts`, the third site goes away.

#### T12-08 — `parseUsdPrice(opts.price)` runs on every request
**File:** `packages/middleware/src/core.ts` (line 451)
**Dimension:** Performance / Code Organization

`parseUsdPrice(opts.price)` parses the integrator's price string on every request, throwing on malformed input. The integrator configures `opts.price` once at adapter construction — the parse result is invariant for the wrapper's lifetime. Per-request work is microseconds but multiplied across request volume, and a misconfigured price crashes every request rather than failing fast at construction.

**Fix:** Pre-parse `opts.price` to a bigint inside `withPaywall` / `fastifyPaywall` (or cache via a module-level WeakMap keyed by opts identity). Throw `InvalidPriceError` at adapter construction, not at request time.

#### T12-09 — Canonical Arc Testnet USDC address and chain ID are duplicated across three files
**Files:** `packages/middleware/src/networks.ts:86`, `contracts/script/Deploy.s.sol:36`, `contracts/scripts/verify-usdc-eip3009.ts:49`
**Dimension:** Cross-File Consistency

The literal `0x3600000000000000000000000000000000000000` appears as a hardcoded constant in three production files, and chain ID `5042002` similarly. Solidity can't import the TS constant, so a single source of truth is intrinsically difficult.

**Fix (optional):** Lowest-risk — add a comment on each literal saying "keep in sync with the other two sites." Higher-effort — pin to a shared `contracts/constants/arc-testnet.json` consumed by the TS scripts; `Deploy.s.sol` already accepts `USDC_ADDRESS` env so the operator can supply it externally.

## Architecture-decision compliance matrix

| Decision | Title | Status | Note |
|---|---|---|---|
| **D1** | Strict x402 v1 wire format | Compliant (drift T12-01) | x402.ts decode/encode is byte-faithful; `errors.ts` vs `core.ts` field-name drift is the only deviation, accommodated by the schema. |
| **D3** | Per-developer vault via EIP-1167 minimal proxy + factory | Compliant | `cloneDeterministic` with salt `bytes32(uint256(uint160(msg.sender)))`; `computeVaultAddress` mirrors off-chain. |
| **D4** | Vault holds gross USDC; fee split at `withdraw()` | Compliant | Reads `balanceOf(this)` as gross; developer-first transfer order; no partial-withdraw API. |
| **D5** | Two-layer replay protection (NonceStore + USDC `authorizationState`) | Compliant | `checkAndInsert` is synchronous + has `validBefore <= now` safety net; settle.ts never touches the store. |
| **D6** | Framework-agnostic core + per-framework adapters | Compliant | `core.ts` knows nothing of fastify/node:http; both adapters are <50 lines and translate `PaywallResult` to HTTP. |
| **D7** | viem 2.x everywhere; no ethers | Compliant | Zero ethers imports across production source. |
| **D8** | Solidity ^0.8.20; OZ 5.x storage-based ReentrancyGuard | Compliant | Verified pragma + storage `ReentrancyGuard` import (not transient). |
| **D10** | Configurable platform fee — owner-only, 0–1000 bps, default 50 | Compliant | Both constructor and setter revert `InvalidFeeBps` on `> 1000`. |
| **D11** | `platformTreasury` settable, separate from `owner` | Compliant | Independent slot, owner-only setter, zero-address guard. |
| **D12** | `Pausable` checked off-chain only | Compliant | Factory inherits `Pausable`; vault has no `whenNotPaused` on `withdraw`. |
| **D13** | Relayer key opaque non-enumerable wrapper | Compliant (docstring nit T12-04) | Module-private `WeakMap`; non-enumerable brand; sole extract in settle.ts; not re-exported by `index.ts`. |
| **D14** | Startup chainId pin + rpcUrl trust | Compliant | `getChainId()` asserted on first use per network in settle.ts; throws `NetworkMismatchError` with both fields. |
| **D15** | Vault impl locked from direct init; no destructive primitives | Compliant | `_disableInitializers()` in constructor; no `selfdestruct`, `delegatecall`, or `assembly` in source. NatSpec invariant verbatim. |
| **D16** | Vault has no `receive()` or `fallback()` payable | Compliant | Source has no payable fallback functions. |
| **D17** | No setters for `developer` / `factory` | Compliant | Verified `grep` — neither `setDeveloper` nor `setFactory` exists. NatSpec invariant verbatim. |
| **D18** | Structured security logging surface | Compliant (drift T12-03) | core.ts is the single emit owner; `try/catch` on every call; `scrubSecrets` applied; `txHash` preserved through `SAFE_HEX_FIELDS` lift. Drift = `internal_error` literal not in catalog. |

## Cross-cutting observations

### Adapter consistency (`adapters/node-http.ts` vs `adapters/fastify.ts`)
Both adapters call `paywall(req, opts)` with the same `PaywallCoreOptions` shape and translate the discriminated `PaywallResult` to HTTP. On 402: write status + headers + JSON body. On passthrough: set `X-PAYMENT-RESPONSE` before user handler runs. `node-http` writes Content-Type explicitly then spreads `result.headers` (redundant but harmless — see T12-07). Fastify lets `reply.send(body)` set Content-Type and iterates `result.headers` via `reply.header(...)`. Handler-exception semantics differ by framework convention: node-http awaits the user handler (exceptions propagate up); Fastify lets its own onError chain handle them. Both are framework-idiomatic — no drift.

### Naming consistency
TS uses camelCase for functions/vars, PascalCase for types/classes, kebab-case for file names. Solidity uses PascalCase for contracts/errors/events, camelCase for functions/storage. The seven settlement sub-reasons are spelled identically wherever they appear, but typed under two distinct names — see T12-02. The eighth `internal_error` literal is the drift surfaced by T12-03.

### Error handling
Every async path has a defined failure mode. The `emit(...)` helper in core.ts wraps logger calls in try/catch per D18. Two intentional empty-catch sites are documented inline: (a) `core.ts:446` swallows pre-7a factoryState read errors and defers to the post-7b retry; (b) `emit` helper catches throwing loggers. No `console.error` in production paths. The single `console.warn` in `networks.ts:76` is the documented T3-notes module-load surface. No raw `0x...` hex leaks: `register.ts:154` scrubs the error message before pattern matching (`classifyError`), `settle.ts` classifier returns fixed tokens only, and `post-deploy.ts:264` emits a static parse-error message rather than forwarding the inner JSON error (per SA-T11-03).

### Shared-resource compliance with Architecture "Shared resources" table
- **PublicClient** — owned by `core.ts` (lazy-init per network at line 179, with PUBLIC_CLIENT_INFLIGHT dedup); consumers `verify.ts`, `settle.ts`, factory-state cache. 1 per network. Compliant.
- **WalletClient** — owned by `settle.ts` (`WALLET_CACHE`, lazy-init in `buildWalletClient`); sole consumer is `settle.ts`. 1 per network. Compliant.
- **NonceStore** — process-singleton at `core.ts:102`, observable across both adapters because both call the module-scope `paywall(...)`. Compliant.
- **factory state cache** — owned by `core.ts` (`FACTORY_STATE_CACHE` 5s TTL); only consumer is core's own pipeline. Compliant.
- **NETWORKS** — module const in `networks.ts`. Compliant.
- **OpaqueRelayerKey** — constructed by integrator, held opaque through core, extracted only in settle.ts (one call site). Compliant.

No leakage of shared state, no duplicate instances.

### Complexity
`paywall()` in core.ts is 225 lines — violates the patterns.md "<50 lines" guideline. The cohesion is intrinsic to the spec (7-step linear pipeline that must run per-request with branching at every step); breaking it would scatter the pipeline without clarifying it. `settleOnChain` is ~129 lines (cache lookup → chainId pin → balance check → sig parse → write → receipt). `verify.ts:99-193` is ~95 lines and reads cleanly. All three are well-commented. No god-objects, no excessive nesting (max 3 levels in core.ts).

### ESM-only invariants
`packages/middleware/package.json` has `"type": "module"`. `grep -n 'require(' packages/middleware/src --include='*.ts'` shows ONE hit — in `settle.ts:29` inside a comment string. No `module.exports`, no `.cjs` files, no `.cts` files. All relative imports use the `.js` extension per Node ESM rules. Invariant holds.

### Custom errors over `require(...)` strings
`grep -n 'require(' contracts/src` → zero hits. The five custom errors (`NotDeveloper`, `AlreadyRegistered`, `InvalidFeeBps`, `ZeroAddress`, `NoBalance`) are all defined and all used. `Deploy.s.sol` uses `require(treasury != address(0), 'treasury_zero')` etc. — acceptable, this is a Foundry script, not a deployed contract.

### NatSpec invariants on `PaymentVaultImpl`
`PaymentVaultImpl.sol:26` carries the exact verbatim string `@custom:security-invariant no_selfdestruct no_delegatecall single_initializer no_setters_for_developer_or_factory`. This is the anchor T13's security audit will rely on.

### Security observations noted for T13 handoff (NOT chased here)
- `core.ts:494` re-reads factory state when pre-7a returned `servedStale`; if BOTH reads return stale, correctly surfaces `rpc_5xx` (no fail-open).
- `verify.ts:103` defensively returns `network_mismatch` for unknown `opts.expectedNetwork` (no panic).
- `settle.ts:148` `normalizePrivateKey` accepts both with and without `0x`; the raw key never leaves the function scope.
- `OpaqueRelayerKey` constructor in `relayer-key.ts:42-57` does NOT validate hex shape — accepts any non-empty string; format validation falls to viem's `privateKeyToAccount`. Acceptable: format validation is the consumer's responsibility (`register.ts:181` already validates against `PRIVATE_KEY_RE`).

All four items are quality-noted; none warrant a code-audit finding.

### Test observations noted for T14 handoff
Code structure inside `__tests__` directories is in scope only when it points at a defect in the source. The forked-e2e test at `__tests__/integration/forked-e2e.test.ts` injects a custom `NetworkConfig` with `usdcEip712Name: 'USD Coin'` (matching `MockUsdcEip3009`'s constructor) rather than the production `'USDC'` from networks.ts. This is a test-time substitution, not a source defect. The mock's domain name diverges from the live chain, but `NETWORKS['arc-testnet']` reads `'USDC'` from the T3 artefact, and an integrator running against real Arc Testnet USDC will sign against `'USDC'`. No source-level bug.

### Layout note (not a finding)
Tech-spec Architecture §"What we're building/modifying" (lines 33–65) references `contracts/contracts/`, `contracts/deploy/01_deploy_factory.ts`, and `hardhat.config.ts`. The shipped layout uses Foundry conventions per D9: `contracts/src/`, `contracts/script/Deploy.s.sol`, `contracts/scripts/post-deploy.ts`, no Hardhat. This is a documented architecture deviation (decisions.md Task 2 / iter-4 §1). The task-12 scope file list at `tasks/12.md` lines 23–28 was updated to match; tech-spec "What we're building/modifying" is now stale relative to the shipped layout. Recommend updating tech-spec to match — observation only.

## Verdict

**advisory**

No Blocker or Major findings. Production wire format is correct, all D1–D18 invariants that constrain code are honored, ESM-only invariants hold, no ethers imports, no forbidden opcodes in Solidity, OpaqueRelayerKey defense-in-depth is intact. Five Minor findings (T12-01 … T12-05) and four Nits (T12-06 … T12-09) address consistency, dead-code, and cross-file drift concerns. Lead should bundle these into a single fixer pass before T16 deploy; none are individually blocking.
