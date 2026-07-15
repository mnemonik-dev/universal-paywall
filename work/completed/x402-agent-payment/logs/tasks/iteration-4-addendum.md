# Iteration 4 — Foundry migration + known-finding fixes

Binding addendum for iteration 4. Tech-spec D9 has been flipped from Hardhat → Foundry. This addendum sets the canonical paths and commands.

## 1. Contract toolchain — Foundry (forge + anvil)

`contracts/` is a Foundry project. Layout:

```
contracts/
  foundry.toml                     # canonical config
  src/
    PaymentSplitterFactory.sol
    PaymentVaultImpl.sol
    interfaces/IERC3009.sol
  test/
    PaymentSplitterFactory.t.sol   # forge test (Solidity)
    PaymentVaultImpl.t.sol
    mocks/
      MockUsdcEip3009.sol
      MockMaliciousTreasury.sol    # for vault.withdraw reentrancy test
    invariants/
      VaultInvariants.t.sol        # forge invariant tests
  script/
    Deploy.s.sol                   # forge script for deploy
  scripts/                         # off-chain TS helpers (not Solidity)
    verify-usdc-eip3009.ts         # Wave 1 spike (uses viem directly)
    post-deploy.ts                 # reads broadcast/run-latest.json,
                                   # patches networks.ts sentinel comments
  remappings.txt                   # @openzeppelin/=lib/openzeppelin-contracts/
  lib/                             # forge install outputs (.gitignored content,
                                   # tracked submodules in .gitmodules)
```

`foundry.toml`:

```toml
[profile.default]
src = "src"
test = "test"
script = "script"
out = "out"
libs = ["lib"]
solc = "0.8.20"
optimizer = true
optimizer_runs = 200
via_ir = false

[profile.ci]
fuzz = { runs = 1000 }
invariant = { runs = 256, depth = 64 }

[rpc_endpoints]
arc_testnet = "${ARC_RPC_URL}"
```

## 2. Mock placement & compilation

Mocks live under `contracts/test/mocks/*.sol`. **Foundry's `test` path is compiled automatically** for test runs — no separate `paths.sources` override needed (this dissolves the round-3 critical on T5). Production sources under `contracts/src/` are NOT polluted with test mocks. NatSpec `@custom:test-only` tags are still added for clarity.

Slither config (`slither.config.json`) excludes `contracts/test/` from production-security severity:

```json
{ "filter_paths": "test/,lib/", "exclude_low": false }
```

## 3. Commands

| Operation                                     | Command                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Compile                                       | `forge build`                                                                                 |
| Tests (unit + fuzz + invariant)               | `forge test`                                                                                  |
| Coverage                                      | `forge coverage --report lcov`                                                                |
| Gas snapshot                                  | `forge snapshot`                                                                              |
| Slither                                       | `slither contracts/src/ --config-file contracts/slither.config.json`                          |
| Local node (for middleware integration tests) | `anvil --chain-id 31337 --port 8545` (T10 spawns this)                                        |
| Forked node (Arc Testnet, optional)           | `anvil --fork-url $ARC_RPC_URL --chain-id 5042002`                                            |
| Deploy                                        | `forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast --verify`                |
| Verify (contract)                             | bundled into `--verify` flag on the deploy script (uses `verifier_url` for arcscan if needed) |

## 4. Per-task adjustments

### T2 — Foundry setup

- Install foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- `contracts/foundry.toml` per §1.
- `forge install OpenZeppelin/openzeppelin-contracts --no-commit` (pinned: tag `v5.0.2`).
- `remappings.txt`: `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`.
- Smoke: `cd contracts && forge build`.
- `.gitmodules` tracks the OpenZeppelin submodule.
- **Drop**: hardhat.config.ts, hardhat-toolbox, hardhat-verify deps.
- **Keep**: viem in `contracts/devDependencies` for the TS-only spike (T3) and post-deploy script.

### T3 — USDC spike

- Stays TS (viem). Reads RPC, writes JSON artifact. Independent of Foundry/Hardhat.

### T4 — Contracts

- Move sources from `contracts/contracts/` → `contracts/src/`. Mocks from `contracts/contracts/mocks/` → `contracts/test/mocks/`.
- `pragma solidity ^0.8.20` (no change).
- OpenZeppelin import paths: `@openzeppelin/contracts/access/Ownable2Step.sol` (same path string thanks to remappings).
- No code changes to the contracts themselves.

### T5 — Contract tests (Foundry)

- Rewrite tests in Solidity per `forge-std/Test.sol`. Tests inherit `Test` and use `vm.*` cheats.
- **Reentrancy tests via Foundry**:
  - `MockMaliciousTreasury` re-enters `vault.withdraw()` during USDC transfer to treasury — forge confirms `ReentrancyGuard` blocks. (Concrete dynamic test, not source-pattern.)
  - For `factory.register()`: structural source-pattern check via `slither --detect reentrancy-eth,reentrancy-no-eth` — no dynamic test (per addendum §15 of iter-3; still applies since register has no callback).
- **Invariant tests** (`test/invariants/VaultInvariants.t.sol`):
  - Forge invariant: `vault.balanceOf == sum(payments) - sum(withdrawn)` (conceptual; refined during impl).
  - Forge invariant: `factory.feeBps() <= 1000` always.
  - Forge invariant: `vault.developer != address(0)` after initialize.
- **Fuzz tests**:
  - `function testFuzz_FeeMath(uint256 gross, uint16 feeBps)` — assert no overflow, no negative net, fee+net == gross.
  - `function testFuzz_RegisterIdempotent(address dev)` — re-registering same EOA reverts `AlreadyRegistered`.
- **CREATE2 cross-component invariant**: use `Clones.predictDeterministicAddress` from OpenZeppelin (Solidity-side) and compare against `factory.computeVaultAddress(dev)`. No off-chain compute needed.
- Coverage target: ≥95% branch via `forge coverage --report lcov` (LCOV thresholds checked by a small grep in CI).
- Verify-smoke: `cd contracts && forge test -vvv && forge coverage --report summary`.

### T10 — Forked integration test (middleware-side)

- Local node: spawn `anvil --chain-id 31337 --port $TEST_PORT` (NOT `hardhat node`). Polls readiness same way.
- Deploy contracts in `beforeAll` via `forge script` from JS (`spawn`), OR programmatically deploy via viem's `walletClient.deployContract` with the compiled bytecode read from `contracts/out/`.
- **Pick**: programmatic deploy via viem (simpler — no second toolchain in the test path).
- The forked-e2e itself stays in `packages/middleware/src/__tests__/integration/`. NOT in `contracts/test/`.
- Vendored ABI: T2 writes a small post-build hook that copies `contracts/out/PaymentSplitterFactory.sol/PaymentSplitterFactory.json` to `packages/middleware/src/abi/` for T7/T10 viem consumption.

### T11 — Deploy script (forge script + TS post-step)

Two-step pipeline:

1. **`contracts/script/Deploy.s.sol`** — forge script (Solidity). Reads env (`ARC_RPC_URL`, `DEPLOYER_KEY`, `PLATFORM_TREASURY_ADDRESS`, `INITIAL_FEE_BPS=50`), deploys `PaymentSplitterFactory`, broadcasts. Run with `forge script ... --broadcast --verify`. Forge emits `broadcast/Deploy.s.sol/5042002/run-latest.json` with deployed addresses.

2. **`contracts/scripts/post-deploy.ts`** — TS post-step. Reads `broadcast/.../run-latest.json`, extracts factory + vaultImpl addresses, patches `packages/middleware/src/networks.ts` via the sed-style sentinel replacement. Commits the change (caller's responsibility, not the script).

`register.ts` CLI (scripts/register.ts at repo root) uses viem to call `factory.register()` from the developer EOA — unchanged from iter-3, no Hardhat dep.

### T13 — Security audit

- `forge test --match-contract Reentrancy` for reentrancy specifically.
- `forge coverage` report reviewed.
- `slither contracts/src/ --config-file contracts/slither.config.json` — hard requirement.
- D1-D18 coverage matrix unchanged.
- All `--workspace` references use `@universal-paywall/middleware` (package-name form).

### T14 — Test audit

- Coverage report from `forge coverage --report lcov` (NOT `npx hardhat coverage`).
- Threshold: ≥95% branch on `contracts/src/` (excluding `test/`, `script/`, `lib/`).
- Forge fuzz/invariant test presence is a hard audit requirement (was implicit before).

### T15 — Pre-deploy QA

Commands:

- `npm test --workspace=@universal-paywall/middleware` — middleware vitest.
- `cd contracts && forge test && forge coverage --report summary` — contracts.
- `ARC_TESTNET_E2E=1 npm run test:e2e --workspace=@universal-paywall/middleware` — live Arc Testnet e2e.

### T16 — Deploy + npm publish

- Contract deploy via `forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast --verify` (handles arcscan verify if `verifier_url` set).
- TS post-step: `npx tsx contracts/scripts/post-deploy.ts` — patches networks.ts.
- Commit & tag the networks.ts update.
- `npm publish --workspace=@universal-paywall/middleware --access=public --tag=alpha --provenance` per iter-3 §1.

### T17 — Post-deploy verification

- On-chain reads via inline `node -e` + viem (unchanged from iter-3).
- ABI: `feeBps() returns (uint16)` (matches T4 + tech-spec Data Models).
- `$REPO_ROOT=$(git rev-parse --show-toplevel)` at top of every block.
- HTTP smoke unchanged.

## 5. Known-finding fixes (apply alongside Foundry migration)

### T1 — pin `--passWithNoTests`

Add explicit comment in `packages/middleware/package.json` `scripts.test` value: `// keep --passWithNoTests until T6 lands first vitest test; do not remove`. OR an AC bullet: "test script must include `--passWithNoTests` until the first test file exists; do not remove it before T6 completes."

### T3 — artifact JSON shape includes `notes?`

`contracts/scripts/arc-testnet-usdc-domain.json` artifact shape:

```json
{
  "name": "USD Coin",
  "version": "2",
  "decimals": 6,
  "supportsEip3009": true,
  "sampleGasCost": "<micro-USDC>",
  "gasCostExceedsThreshold": false,
  "notes": ["arc-dual-decimal: native gas is 18-decimal but ERC-20 view is 6"]
}
```

T6 reads `notes` and surfaces any items at module load (informational, not blocking).

### T5 — minor wording fixes

- `loadFixture` is **async** (returns Promise). Hint should say "always await it; do not use deprecated async-named variants".
- `__dirname` is available in CJS Hardhat test contexts but not in ESM contexts; with the Foundry switch, T5 is Solidity, so this note is N/A — drop the note entirely from T5.

### T8 — workspace name form

All `--workspace=packages/middleware` → `--workspace=@universal-paywall/middleware`. T8 currently uses path form; switch to package name to align with T6, T7, T9, T10, T13, T14, T15.
