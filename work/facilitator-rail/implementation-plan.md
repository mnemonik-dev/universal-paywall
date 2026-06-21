---
feature: facilitator-rail
doc: implementation-plan
status: in-progress
created: 2026-06-17
author: claude
input: facilitator-rail-design.md
branch: feat/facilitator-rail
---

# Implementation Plan — Facilitator + Session-Key Settlement Rail

Turns `facilitator-rail-design.md` into a buildable MVP. This resolves the design
doc's open questions with concrete, scoped defaults, then implements the core.

## Locked decisions (resolving the design's open questions)

| Open question | MVP decision |
|---|---|
| Charge-auth model | **API-key at the facilitator** (creator authenticates to the facilitator); on-chain authorization is the facilitator address registered in the payer's policy. Creator-signed receipts = documented future hardening. |
| Session-key mechanism | **The policy designates a `facilitator` address.** That address is the delegated authority ("session key"). It calls `settle()` directly, so the tx signature *is* the authorization. No separate AA framework. |
| Settlement primitive | **Locked prepaid stake** in a payer-owned `StakeVault`. The facilitator settles batches against it; the payer reclaims the unencumbered remainder anytime and everything after expiry. |
| Payout target | **Direct transfer to the creator's address** (feeless, x402-pure). Per-creator counterfactual payout vaults / revenue-splitting = future extension. |
| Allowed-payee restriction | **Bounded by `cap` only** for MVP (worst-case loss = payer-chosen cap). Merkle/registry payee allowlist = documented next hardening. |
| Deposit funding | **`approve` + `deposit`** (ERC-20 pull). Gasless EIP-3009 `receiveWithAuthorization` funding = future enhancement. |
| Fee | **None in the rail.** Fee lives at the facilitator layer (off-chain, market-set). |

## On-chain rail (this commit)

```
contracts/src/rail/
  StakeVault.sol          # payer-owned, non-custodial; deposit / grantPolicy /
                          # revoke / settle (batched, facilitator-only, cap+expiry
                          # bounded) / withdrawRemainder
  StakeVaultFactory.sol   # counterfactual CREATE2 (salt commits to payer);
                          # feeless, ownerless, pauseless, permissionless
contracts/test/rail/
  StakeVault.t.sol
  StakeVaultFactory.t.sol
  mocks/MockUSDC.sol
```

### Non-custodial guarantees (enforced on-chain)
- Only `payer` can withdraw the remainder; the facilitator can never move funds to
  itself beyond the payer-set `cap`, and never touch the unencumbered balance.
- The facilitator's authority is bounded by `{cap, validUntil}` and revocable.
- `revoke()` shortens `validUntil` to at most `now + REVOKE_COOLDOWN`, leaving the
  facilitator a bounded window to settle already-served charges before the
  encumbered stake unlocks.

## Off-chain (subsequent commits)

```
packages/facilitator/   # external, permissionless service:
                        #   POST /charge  (metered usage, API-key auth)
                        #   batches per (payer→creator) window
                        #   submits StakeVault.settle() via viem; pays gas
packages/sdk/           # thin creator client: charge(payer, amount, ref) → HTTP
```

The facilitator's pure logic (ledger + batching) is unit-tested; the on-chain
submit is behind a `Settler` interface so tests don't need a live chain.

## Status checklist

- [x] Rail contracts + Foundry tests (green) — `contracts/src/rail/`, 39 tests pass
- [x] Facilitator core (ledger + batching) + vitest — `packages/facilitator/`, 14 tests pass
- [x] Facilitator HTTP API — `packages/facilitator/src/server.ts`
- [x] Creator SDK — `packages/sdk/`, 4 tests pass
- [x] Wire-up notes + remaining-work doc — `STATUS.md`
