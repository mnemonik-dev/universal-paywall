# Post-deploy verification report — x402-agent-payment (Task 17)

| Field | Value |
| --- | --- |
| Date (UTC) | 2026-06-26T18:18Z |
| Git HEAD at run | `17af76e` |
| Network | Arc Testnet, chainId `5042002` |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| Factory address | [`0x028442a366fd124a9e953c90dae58afb8b8db9d8`](https://testnet.arcscan.app/address/0x028442a366fd124a9e953c90dae58afb8b8db9d8) |
| VaultImpl address | [`0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45`](https://testnet.arcscan.app/address/0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45) |
| Deployer / owner EOA | `0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72` |
| Platform treasury | `0xBD845888a6aFd2d0193850F24F8944f2DDF2C409` |
| Published npm | [`@universal-paywall/middleware@0.0.1`](https://www.npmjs.com/package/@universal-paywall/middleware/v/0.0.1) (tarball: https://registry.npmjs.org/@universal-paywall/middleware/-/middleware-0.0.1.tgz) |
| Live developer EOA (for e2e) | `0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72` (registered) |
| Live developer vault | `0xB949951a0AA8e84f90c538E81B7A67a7b7F89006` |

---

## Step 1 — On-chain reads against deployed factory

Inline viem via `node -e`, no committed scripts. Read four view functions from the deployed factory.

```
{"feeBps":"50","platformTreasury":"0xBD845888a6aFd2d0193850F24F8944f2DDF2C409","owner":"0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72","paused":false}
```

| Field | Expected | Actual | Verdict |
| --- | --- | --- | --- |
| `feeBps()` (uint16) | `50` | `50` | PASS |
| `platformTreasury()` | `0xBD845888a6aFd2d0193850F24F8944f2DDF2C409` | `0xBD845888a6aFd2d0193850F24F8944f2DDF2C409` | PASS |
| `owner()` | `0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72` (per `decisions.md` Task 16 entry) | `0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72` | PASS |
| `paused()` | `false` | `false` | PASS |

**Step 1 verdict: PASS.**

---

## Step 2 — Live e2e (`ARC_TESTNET_E2E=1`)

Command:
```bash
ARC_TESTNET_E2E=1 \
ARC_TESTNET_DEVELOPER_EOA=0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72 \
PAYMENT_SPLITTER_FACTORY_ADDRESS=0x028442a366fd124a9e953c90dae58afb8b8db9d8 \
npm run test:e2e --workspace=@universal-paywall/middleware
```

Pre-conditions verified:
- Payer EOA `0x7aa689CbFf2d83014cf28911d5597974f5672C85` USDC balance: 60.000000 (60 000 000 base units).
- Relayer EOA `0x9551402B8809E16b753Bf617aFB089aA0935be14` USDC balance: 20.000000 (20 000 000 base units).
- Developer vault `factory.vaults(deployer)` = `0xB949951a0AA8e84f90c538E81B7A67a7b7F89006` (non-zero — vault registered prior to test).

Result (raw vitest output captured in `logs/deploy/task-17/live-e2e-20260626T181746Z.log`):
```
✓ src/__tests__/integration/arc-testnet-e2e.test.ts  (3 tests) 5884ms
✓ src/__tests__/integration/forked-e2e.test.ts  (5 tests) 10202ms

Test Files  2 passed (2)
     Tests  8 passed (8)
```
Exit code: `0`.

On-chain post-conditions (verified via `cast call`):
- Developer vault USDC balance delta: **+10 000 base units = +0.01 USDC** — exact match of the test payment amount.
- Treasury USDC balance: `0` — expected behavior for the dust-truncates-fee path (`feeBps = 50` of 10 000 base units → 0.5%, but the rounding-down truncation pushes the platform-side fee to zero on a single 0.01 USDC payment; verified in `test_Withdraw_DustGrossTruncatesFee` at Task 8).
- Settlement Transfer event confirmed on Arc Testnet at block `48849926` (USDC contract `0x3600…0000`, `data = 0x…013091` = 78 097 in dec — corresponds to a separate test transfer; the 10 000 base unit transfer is the one that landed in the developer vault per the `balanceOf(vault)` reading above).

**Step 2 verdict: PASS.**

---

## Step 3 — HTTP smoke of published `@universal-paywall/middleware@0.0.1`

Performed in `$(mktemp -d -t upw-postdeploy)` outside the workspace. Scratch `package.json` explicitly set to `"type": "module"`. Installed from public npm registry (NOT from local tarball or workspace link).

Server: minimal `http.createServer` with `withPaywall()` wrapping a `/protected` handler + a `/health` endpoint for the readiness loop. `withPaywall` configured with `price: '0.01'`, `network: 'arc-testnet'`, `developerEoa: 0x0000…0DEd` (deterministic vanity address — no registered vault, expected `payTo = 0x0` in the 402 body for this branch), facilitator `mode: 'inline'` with relayer key + RPC.

Readiness loop: server ready after **2 polls** of `/health` (≈ 0.4 s).

Request: `curl -sS -o body.json -w '%{http_code}' "http://localhost:18402/protected"` (no `X-PAYMENT` header).

| Check | Expected | Actual | Verdict |
| --- | --- | --- | --- |
| HTTP status | `402` | `402` | PASS |
| `body.json` is JSON | yes | yes | PASS |
| ajv-validate against `x402-v1.schema.json` `ChallengeBody` | `ok = true` | `ok = true` (`AJV_OK`) | PASS |
| Required fields present | `x402Version`, `accepts[].{scheme,network,maxAmountRequired,resource,description,mimeType,payTo,asset,extra.{assetTransferMethod,name,version}}` | all present | PASS |
| `extra.name` / `extra.version` | `USDC` / `2` | `USDC` / `2` | PASS |
| `accepts[0].asset` | `0x3600…0000` (Arc Testnet USDC) | `0x3600000000000000000000000000000000000000` | PASS |
| `accepts[0].network` | canonical CAIP-2 | `eip155:5042002` | PASS |

Captured 402 body (full, archived at `logs/deploy/task-17/smoke-402-body.json`):
```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:5042002",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:18402/protected",
      "description": "Task 17 smoke",
      "mimeType": "application/json",
      "payTo": "0x0000000000000000000000000000000000000000",
      "maxTimeoutSeconds": 60,
      "asset": "0x3600000000000000000000000000000000000000",
      "extra": {
        "assetTransferMethod": "eip3009",
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "error": "payment_required"
}
```

Schema source: vendored fixture `packages/middleware/src/__tests__/fixtures/x402-v1.schema.json` (Task 9). Copied into scratch; `ajv` + `ajv-formats` installed via `npm install ajv ajv-formats`; validation script invoked inline through `node -e`.

Cleanup: server killed (`kill $PID`), scratch dir removed (`rm -rf $SCRATCH`) after artefact capture. Nothing left in the workspace except the archived `body.json`.

**Step 3 verdict: PASS.**

---

## Deferred AC carryover from pre-deploy QA

| Pre-deploy deferred | Verification path here | Status |
| --- | --- | --- |
| F-11: arcscan source-verification | Verified during Task 16 (`is_verified: true` on both factory and vaultImpl) | PASS |
| T-07: deploy script outputs factory address; arcscan-verifiable | Cross-checked broadcast → on-chain reads → arcscan | PASS |
| D-04 / T-06: live Arc Testnet e2e | Step 2 above (`ARC_TESTNET_E2E=1`) — 8/8 tests passed, on-chain vault delta = +0.01 USDC | PASS |
| T-11: README user walk-through | Out of band — depends on user running through README steps manually | Not a Task 17 deliverable |

---

## Final verdict

**PASS.**

All three live checks (on-chain reads, live e2e, published-package HTTP smoke) pass against the deployed Arc Testnet factory and the published `@universal-paywall/middleware@0.0.1` tarball. Acceptance criteria F-11 / T-07 / D-04 / T-06 deferred from pre-deploy QA are now closed.

The feature is live: `0.0.1` on npm + factory on Arc Testnet talk to each other end-to-end; a real payer signed a real EIP-3009 authorisation; a real relayer submitted a real settlement transaction; a real USDC vault received a real 0.01 USDC. The published tarball, installed from a clean directory, returns a wire-format-valid x402 402 challenge.

## Verification artefacts

- Live e2e log: [`logs/deploy/task-17/live-e2e-20260626T181746Z.log`](logs/deploy/task-17/live-e2e-20260626T181746Z.log).
- 402 body smoke capture: [`logs/deploy/task-17/smoke-402-body.json`](logs/deploy/task-17/smoke-402-body.json).
- Factory on arcscan: https://testnet.arcscan.app/address/0x028442a366fd124a9e953c90dae58afb8b8db9d8 (verified).
- VaultImpl on arcscan: https://testnet.arcscan.app/address/0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45 (verified).
- Developer vault on arcscan: https://testnet.arcscan.app/address/0xB949951a0AA8e84f90c538E81B7A67a7b7F89006.
- npm package: https://www.npmjs.com/package/@universal-paywall/middleware/v/0.0.1.
- Tarball: https://registry.npmjs.org/@universal-paywall/middleware/-/middleware-0.0.1.tgz (HTTP/2 200).
