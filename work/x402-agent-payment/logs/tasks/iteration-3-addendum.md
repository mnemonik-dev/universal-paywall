# Iteration 3 — Systemic Fixes Addendum

Reads alongside `iteration-2-systemic-fixes.md`. These are NEW binding decisions for iteration 3.

## 1. Canonical factory constructor signature (3 args)

`PaymentSplitterFactory` constructor is **exactly 3 arguments**, per tech-spec D3 + Data Models:

```solidity
constructor(IERC20 _usdc, address _platformTreasury, uint16 _initialFeeBps)
```

`vaultImpl` is **deployed inside the constructor** (`vaultImpl = address(new PaymentVaultImpl())`), NOT passed as a constructor argument. `initialOwner` is set via the `Ownable2Step` base — defaults to `msg.sender` of the deploy tx.

T4 implementation, T11 deploy script, T16 hardhat verify call must all match this 3-arg signature. `feeBps` is `uint16`, not `uint256`.

## 2. SecurityLogger emission ownership (single owner = core.ts)

**Only `core.ts` calls `logger.securityEvent(...)`**. `settle.ts` and `verify.ts` do NOT import the logger. They return classified results; `core.ts` is the policy enforcement point and decides which events to fire.

T7 (settle.ts, verify.ts): no `logger` parameter, no SecurityLogger calls.
T8 (core.ts): receives logger via `opts`, fires events at each event point per the D18 table.
T9 (tests): SecurityLogger emissions are tested from `core.test.ts` only. `verify.test.ts` and `settle.test.ts` assert only the return-value taxonomy (reason strings, ok/error). The mapping "verify returns invalid_signature → core fires signature_invalid event" is tested in `core.test.ts`.

## 3. `verifyEip3009Authorization` canonical signature (2-arg)

```ts
function verifyEip3009Authorization(
  payload: PaymentPayload,
  opts: {
    expectedVaultAddress: `0x${string}`,
    expectedNetwork: string,
    maxAmountRequired: bigint,
    publicClient: PublicClient,
    nonceStore: NonceStore,
    nowMs: number,    // injectable for tests; defaults to Date.now()
  }
): Promise<{ ok: true } | { ok: false, error: VerifyError }>
```

`nonceStore` lives in `opts`, NOT a third argument. T8 calls with the 2-arg shape.

## 4. parseUsdPrice('0') — throws

`parseUsdPrice('0')` throws `InvalidPriceError`. Reason: zero-amount payments are not meaningful (still consume gas to settle, agent gets nothing). The regex in T6 should be tightened OR a post-regex value check `if (result === 0n) throw new InvalidPriceError('zero')`. T9 tests this throw path.

Same for negative, NaN, scientific notation, whitespace, >6 decimals — all throw.

## 5. payerHash slice length (canonical: 10 characters = `0x` + 8 hex)

Per T8 spec: `payerHash = '0x' + keccak256(authorization.from).slice(2, 10)`. That's `0x` prefix + 8 hex chars = 10-char string total. T9 asserts the 10-char form.

## 6. Settlement classifier shape (T7 settle.ts)

`settle.ts` returns:
```ts
type SettleResult =
  | { ok: true; txHash: `0x${string}`; payer: `0x${string}` }
  | { ok: false; reason: SettleReason; details?: { gasEstimate?: bigint; balance?: bigint } };

type SettleReason =
  | 'rpc_timeout'           // RPC fetch hung / timed out (mapped from RpcRequestError / fetch timeout)
  | 'rpc_5xx'               // RPC returned 5xx
  | 'gas_estimate_revert'   // estimateGas / simulateContract reverted
  | 'mine_timeout'           // waitForTransactionReceipt threw WaitForTransactionReceiptTimeoutError
  | 'receipt_reverted'       // receipt.status === 'reverted'
  | 'relayer_no_balance'     // proactive USDC balanceOf check OR reactive insufficient gas error
  | 'authorization_already_used_onchain';  // USDC reverted with "FiatTokenV2: authorization is used or canceled" (string match)
```

For `authorization_already_used_onchain`: do **NOT** use a 4-byte selector. Circle FiatTokenV2 uses `require()` with a string reason. Classifier matches the revert string substring `"authorization is used"` (case-insensitive). If the revert reason cannot be decoded, fall back to `receipt_reverted`.

## 7. Relayer balance threshold (canonical)

Proactive check before `writeContract`:
```ts
const relayerBalance = await publicClient.readContract({
  abi: erc20Abi,
  address: NETWORKS[network].usdcAddress,
  functionName: 'balanceOf',
  args: [relayerAddress],
});
const MIN_RELAYER_USDC_BALANCE = 1_000_000n;  // 1 USDC (6 decimals)
if (relayerBalance < MIN_RELAYER_USDC_BALANCE) {
  return { ok: false, reason: 'relayer_no_balance', details: { balance: relayerBalance } };
}
```

Threshold is `1_000_000n` (1 USDC). T9 mock setups use this constant. NOT `gasEstimate * 2`.

## 8. validBefore safety margin (in milliseconds throughout)

Both prose and code use **milliseconds**: `validBefore` field is interpreted as Unix epoch in seconds (per EIP-3009), but the safety margin comparison happens after converting to milliseconds:

```ts
const validBeforeMs = Number(authorization.validBefore) * 1000;
const SAFETY_MARGIN_MS = 5_000;
if (validBeforeMs <= nowMs + SAFETY_MARGIN_MS) {
  return { ok: false, error: 'authorization_expired' };
}
```

T7 description: 5000 ms safety margin (5 seconds). T9 boundary test: `validBefore = nowSec + 4` (4s ahead) fails; `validBefore = nowSec + 6` (6s ahead) passes.

## 9. vitest installation owner = T1

T1 installs `vitest` (and `ajv`) as root devDependencies AND in `packages/middleware/devDependencies`. T6 can run `npm test` immediately. Update T1 deliverables.

Other middleware-side devDeps in T1: `tsup`, `typescript`, `tsx`, `vitest`, `ajv`, `pino`, `winston` (the last two for relayer-key redaction smoke tests in T6).

## 10. Hardhat node spawning for T10 forked-e2e

T10 forked-e2e tests do NOT use the in-process Hardhat network (no HTTP). Instead:

```ts
// In test setup (beforeAll):
const hardhatNode = spawn('npx', ['hardhat', 'node', '--port', String(TEST_PORT)], { cwd: 'contracts' });
await waitForPort(TEST_PORT, { timeout: 30_000 });  // poll readiness, 30s max
// Use viem PublicClient with http(`http://127.0.0.1:${TEST_PORT}`)
```

Alternative: use viem's `custom(hre.network.provider)` transport in tests. Pick the spawn approach — it's closer to production.

Set Mocha timeout in the `describe` callback (use `function()`, not arrow):
```ts
describe('forked e2e', function () {
  this.timeout(60_000);
  // tests
});
```

## 11. `__dirname` replacement for ESM tests

In any ESM test file that needs the source directory:
```ts
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
```

T11 register-cli.test.ts uses this pattern.

## 12. OpaqueRelayerKey extract — internal import only

`scripts/register.ts` and `packages/middleware/src/__tests__/register-cli.test.ts` import the extract function directly from the internal module:

```ts
import { getRelayerKeySecret } from '../../packages/middleware/src/relayer-key.js';
```

(or relative path from the consumer). The public `index.ts` does NOT re-export it.

## 13. viem in contracts/ workspace

T2 adds `viem` to `contracts/devDependencies`. T5 uses `viem`'s `getContractAddress({opcode: 'CREATE2'})` for off-chain CREATE2 address computation in tests.

## 14. Hardhat config — single `paths.sources`

`paths.sources` is a single string, NOT an array. T5 should NOT recommend `['./contracts', './test/mocks']`. Mocks live in `contracts/test/mocks/` and are discovered by the test runner (Mocha) via standard `contracts/test/**/*.test.ts` glob — they do not need to be in `paths.sources`.

If a mock needs to be compiled by Hardhat for use in tests, place it under `contracts/contracts/mocks/` (the canonical sources path) but DOCUMENT it as test-only (e.g., NatSpec `@custom:test-only`) and exclude from coverage / production deploy via a lint rule.

## 15. T5 register reentrancy invariant — replace test design

The factory `register()` reentrancy invariant cannot be tested as originally written because `PaymentVaultImpl.initialize()` does not call back to the developer EOA (no callback path exists).

Replacement: a **structural invariant** test that asserts `factory.register()` uses checks-effects-interactions (CEI) order. Specifically:
- The line that writes `vaults[msg.sender] = vault` MUST happen AFTER `Clones.cloneDeterministic(...)` and BEFORE `IPaymentVault(vault).initialize(...)`.
- Verify by reading the contract source via Slither or a simple regex-based source check.

OR: drop the test entirely and document in T5 that `register()` reentrancy is structurally impossible (no external calls before state writes that could re-enter).

Pick the second option — drop the test, document the invariant in T4 NatSpec and T13 audit checklist.

## 16. T13 stale `--workspace=packages/middleware` → `@universal-paywall/middleware`

All references in T13 use the package-name form `--workspace=@universal-paywall/middleware`, matching T14 and T15.

## 17. T13 stale Context Files path

T13 references `packages/middleware/src/__tests__/` (canonical), NOT `packages/middleware/__tests__/`.

## 18. T14 register CLI test path

T14 audit checklist references `packages/middleware/src/__tests__/register-cli.test.ts` (T11's canonical location), NOT `scripts/__tests__/register.test.ts`.

## 19. T2 reviewer paths — repo-relative

Replace `/Users/syi/src/universal-paywall/work/...` with `work/x402-agent-payment/logs/working/task-2/...` in the Reviewers section.

## 20. T16 sentinel attribution

T16 references "Task 6 (creates networks.ts with sentinel comments) / Task 11 (sed substitution)" — NOT Task 13 (which is the security audit, not a deploy participant).
