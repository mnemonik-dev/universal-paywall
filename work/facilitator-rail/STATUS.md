---
feature: facilitator-rail
doc: status
status: mvp-implemented
created: 2026-06-17
author: claude
branch: feat/facilitator-rail
---

# Status — Facilitator + Session-Key Rail (MVP implemented)

The design in `facilitator-rail-design.md` is implemented end-to-end as an MVP:
a feeless non-custodial on-chain rail, an external batching facilitator service,
and a one-call creator SDK. All three tiers are built, typechecked, and tested.

## What's implemented

### 1. Rail — `contracts/src/rail/` (Foundry, Solidity 0.8.20)
- **`StakeVault.sol`** — per-payer, non-custodial prepaid stake. `deposit` /
  `grantPolicy(facilitator, cap, validUntil)` / `revoke` (cooldown) /
  `settle(creators[], amounts[])` (facilitator-only, cap+expiry bounded, batched)
  / `withdrawRemainder` / `encumbered` / `withdrawable`. **No owner, no fee, no
  pause.**
- **`StakeVaultFactory.sol`** — counterfactual CREATE2 (salt commits to payer),
  `createVault` / `computeVaultAddress`. **Feeless, ownerless, pauseless,
  permissionless.**
- Tests: `contracts/test/rail/` — **39 passing** (8 factory + 31 vault incl. fuzz),
  covering the non-custodial guarantees (facilitator bounded by cap, payer always
  reclaims remainder, revoke cooldown window).

### 2. Facilitator — `packages/facilitator/` (TS, ESM)
External, permissionless service. **Not part of any creator deployment.**
- `ledger.ts` — pending-charge store (idempotent by `ref`, requeue on failure).
- `batcher.ts` — aggregates many charges into one `settle(creators, amounts)`
  (amounts summed per payee → gas amortized).
- `service.ts` — accepts charges, flushes per payer at count/age threshold,
  requeues on failure.
- `settler.ts` — viem-backed `OnChainSettler` (signs `StakeVault.settle` with the
  facilitator session key, pays gas) + `createVaultResolver`.
- `server.ts` — HTTP: `GET /health`, `POST /charge` (x-api-key), `POST /flush`.
- `cli.ts` — `up-facilitator` bin; config from env.
- Tests: **14 passing** (ledger, batcher, service with a mock settler — no chain).

### 3. Creator SDK — `packages/sdk/` (TS, ESM)
- `createPaywallClient({ facilitatorUrl, apiKey }).charge({ payer, creator, amount, ref })`
  — the entire integration: one POST per billable event, no keys/gas/chain code.
- Tests: **4 passing** (auth header, amount stringify, ref omission, error path).

## Verification

```bash
# contracts (foundry)
cd contracts && forge test --match-path 'test/rail/*'        # 39 passed

# facilitator + sdk
npm run typecheck --workspace=@universal-paywall/facilitator # clean
npm run typecheck --workspace=@universal-paywall/sdk         # clean
npm test --workspace=@universal-paywall/facilitator          # 14 passed
npm test --workspace=@universal-paywall/sdk                  # 4 passed
```

> Toolchain note: this environment had no Foundry/solc/gitleaks and no installed
> node_modules on entry. They were fetched from GitHub/npm (allowlisted) to run
> the suites above. A normal dev box with Foundry + `npm install` runs them as-is.

## End-to-end flow (how the tiers connect)

```
payer:      StakeVaultFactory.createVault(payer); USDC.approve; vault.deposit(stake);
            vault.grantPolicy(facilitatorAddr, cap, validUntil)
creator:    createPaywallClient({...}).charge({ payer, creator, amount })   // per event
facilitator: batches charges → StakeVault.settle(creators, amounts)         // pays gas
payer:      vault.withdrawRemainder(...) / revoke() anytime
```

## Facilitator env config (`up-facilitator`)

| Var | Meaning |
|---|---|
| `ARC_RPC_URL` | JSON-RPC endpoint |
| `CHAIN_ID` | EIP-155 chain id |
| `FACILITATOR_KEY` | session-key EOA private key (registered in payer policies) |
| `STAKE_VAULT_FACTORY` | deployed `StakeVaultFactory` address |
| `FACILITATOR_API_KEYS` | comma-separated accepted creator API keys |
| `BATCH_MAX_CHARGES` / `BATCH_MAX_AGE_MS` | batching window (default 50 / 15000) |
| `PORT` | HTTP port (default 8402) |

## Deliberate MVP scope cuts (documented, not forgotten)

- **Direct-to-creator settlement** (no per-creator payout vault yet). Revenue-split
  payout vaults = next extension.
- **Payee restriction = cap-bound only.** Merkle/registry allowlist of payees =
  next hardening (`settle` would verify a proof per payee against a policy root).
- **Charge auth = API key** at the facilitator. Creator-signed usage receipts
  (dual-auth so neither facilitator nor creator can fabricate a charge) = next
  hardening; `settle` would take receipts + verify creator signatures.
- **Deposit via `approve`+`deposit`.** Gasless EIP-3009 `receiveWithAuthorization`
  funding = enhancement.
- **In-memory ledger.** Durable store + crash recovery for production.
- **No x402 `402` edge handler yet** — the grant/first-interaction wire handler
  (issue a 402, accept a stake/permission grant) is the remaining integration
  piece to make standard x402 agents drive the flow.

## Added this session

- [x] **Deploy script** — `contracts/script/DeployStakeRail.s.sol` (feeless
      factory; only USDC arg). Compiles; mirrors the repo's `Deploy.s.sol`.
- [x] **x402 `402` edge** — `packages/facilitator/src/x402.ts`: `build402Body`
      (stake-scheme 402 with grant instructions) + `checkGrant` gate (reads
      `vault.policy()`, validates facilitator/expiry/remaining) + viem
      `createPolicyReader`. 6 new vitest tests (facilitator now 20 passing).
- [x] **Local anvil e2e (settle path)** — `packages/facilitator/scripts/e2e-anvil.ts`
      (`npm run e2e:anvil -w @universal-paywall/facilitator`): deploy → createVault
      → deposit → grant → 2 charges via the real `OnChainSettler` → **batched
      on-chain settle** → creator got aggregated 150000, vault `spent==150000`,
      payer `withdrawable==400000`. **PASS** (anvil 31337).
- [x] **Resource-server adapter** — `packages/resource-adapter/`: `withStakePaywall`
      (Node http) + framework-agnostic `evaluateAccess` gate. Verifies a payer
      proof signature, gates on the on-chain grant (`checkGrant`), returns a `402`
      with `build402Body` instructions when absent, serves on success, then reports
      metered usage to the facilitator via the SDK. **8 vitest tests** (all gate
      branches). Typecheck + build clean.
- [x] **Full-loop adapter e2e** — `packages/resource-adapter/scripts/e2e-adapter-anvil.ts`
      (`npm run e2e:anvil -w @universal-paywall/resource-adapter`): real facilitator
      HTTP server + real resource server. Agent with no proof → **402
      payer_required**; agent with a signed proof + active grant → **200 served**;
      adapter reports the charge → facilitator settles on-chain → **creator paid
      50000**. **PASS** (anvil 31337).

## Remaining work (next session)

- [ ] Testnet e2e on Arc Testnet (same flow against live USDC + a deployed factory).
- [ ] Payee allowlist + signed-receipt hardening (dual-auth on `settle`).
- [ ] Gasless EIP-3009 `receiveWithAuthorization` funding; durable ledger.
- [ ] Fastify adapter + a small agent-side client helper (sign proof, grant, retry).
- [ ] Extract a `@universal-paywall/rail-core` for the shared read-only primitives
      (currently the adapter imports them from `@universal-paywall/facilitator`).
- [ ] Reconcile the old-paradigm docs (`tech-spec`, `decisions`, diagrams,
      project-knowledge) per `../x402-agent-payment/` review — or supersede them.
