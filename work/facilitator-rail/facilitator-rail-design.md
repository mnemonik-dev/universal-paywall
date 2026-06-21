---
feature: x402-agent-payment
doc: facilitator-rail-design
status: draft
created: 2026-06-17
author: claude
relates_to: review.md, economics-review.md, external-analysis.md, x402-alignment (discussion)
supersedes_intent: per-payment self-hosted-facilitator MVP (see economics-review.md)
---

# Design: Permissionless Facilitator + Session-Key Settlement Rail

A forward design for Universal Paywall's agent/creator payment path. It keeps the
**rail feeless, permissionless, and non-custodial**, moves all execution work to an
**external, swappable facilitator service**, and makes creator/platform integration
**seamless** (an SDK + HTTP call, no keys, no gas, no facilitator to run).

This resolves the gaps in `economics-review.md` (per-payment gas ≫ fee; relayer
fragility; mandatory platform fee) and the x402-alignment tension (centralizing
rent-taking middleman), while preserving a clear place to charge a fee — at the
*optional* facilitator layer, not in the rail.

> Naming note: this is described as a **facilitator + session-key rail**. We do not
> brand it "account abstraction"; session keys / spending policies are the
> mechanism, not the identity.

## Three tiers (strict separation of concerns)

```
  Payer (agent / platform user)
     │  (1) lock a stake + grant a scoped, revocable session-key policy
     ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  RAIL  — smart contracts (feeless, permissionless, pauseless) │
  │  • payer deposit/stake account (payer-controlled, non-custodial)│
  │  • per-creator counterfactual payout vault                    │
  │  • on-chain policy enforcement (cap / rate / expiry / payees)  │
  └─────────────────────────────────────────────────────────────┘
     ▲                                   ▲
     │ (4) batched settlement within     │ (5) creator withdraws
     │     the payer's policy            │     (deploy-on-withdraw)
  ┌──────────────────────────┐           │
  │ FACILITATOR (external)    │      ┌────────────────────────────┐
  │ • permissionless, swappable│◀─────│ CREATOR / PLATFORM          │
  │ • holds delegated session  │ (2)  │ • imports SDK, calls HTTP   │
  │   key (bounded authority)  │ HTTP │   POST /charge per event    │
  │ • meters + (3) batches     │charge│ • NO keys, NO gas, NO       │
  │ • submits tx, pays gas     │      │   facilitator to run        │
  │ • takes a fee for the job  │      └────────────────────────────┘
  └──────────────────────────┘
```

The **facilitator is never part of the creator's deployment.** Creators integrate
seamlessly; a separate external service does the on-chain work on their behalf.

## Roles

| Tier | Who | Responsibilities | Holds keys? | Pays gas? |
|---|---|---|---|---|
| **Payer** | AI agent, or a platform user | Funds + **locks a stake**; grants a **scoped, revocable** session-key policy (max total, per-period rate, expiry, allowed payees/facilitator). Keeps the master key. | Master key (own funds) | No |
| **Creator / platform** | Owncast/Navidrome/Jellyfin/RSSHub operator, or any HTTP API | Imports a thin SDK; emits a charge/usage intent per event (`POST /charge`) **or** exposes a webhook the facilitator subscribes to. Receives net funds to its payout vault. | **None** | No |
| **Facilitator** | **External, permissionless service** — runnable by anybody (us as a paid hosted option, the platform itself, or a 3rd party) | Receives charge intents; authorizes via the payer-delegated session key **within policy**; **batches** many micro-charges; submits settlement tx; pays gas; **takes a fee**. | Delegated **session key** (bounded authority only) | **Yes** (reimbursed via fee) |
| **Rail** | Smart contracts (deployed once, ownerless) | Custody-free stake accounts + per-creator counterfactual payout vaults; **enforces the session-key policy on-chain**; routes payer→creator; **no protocol fee**. | — | — |

## Trust model (non-custodial, bounded)

- **Principal never leaves payer control.** The stake is locked in a
  **payer-owned** account contract; the payer can reclaim the unused remainder and
  **revoke** the session key at any time. The facilitator and creator only ever
  hold *delegated, capped* authority — never the funds.
- **Worst case is bounded by the on-chain policy.** A rogue or compromised
  facilitator cannot spend beyond `{cap, rate, expiry, allowed payees}`; the
  contract rejects anything outside it. No backend bug can exceed the envelope the
  payer signed.
- **Stake = locked deposit, settled against (unidirectional channel).** Critical
  refinement: the facilitator **serves first, settles after**, so it carries the
  served-but-unsettled gap. If the stake were a *liquid* balance the payer could
  drain-and-revoke after consuming. Locking the stake (with refund of the unused
  remainder on close) removes that risk — the facilitator/creator settle against
  funds the payer cannot pull mid-window.
- **Fee lives at the facilitator layer only.** Because facilitators are swappable
  and the rail privileges none, the fee is *market-set and optional*, not protocol
  rent. This is what keeps the design x402-aligned.

### Charge authorization — two tiers
1. **MVP (seamless):** the creator authenticates to the facilitator (API key /
   signed request) and its `POST /charge` is treated as the usage attestation.
   Bounded by the payer's on-chain policy. Maximum integration simplicity.
2. **Hardened (trust-minimized):** each charge carries a **creator-signed usage
   receipt** + the facilitator's session-key signature → the contract requires
   **both**, so neither party can fabricate or inflate a charge alone. Costs the
   creator a signing key (slightly less seamless). Offer as an opt-in tier.

## Lifecycle

1. **Grant (once / per session).** Payer locates its **counterfactual** account
   address (precomputed; no pre-deploy), funds + **locks a stake**, and grants a
   **session-key policy** to a chosen facilitator. Can be triggered at the edge by
   a standard **x402 `402`**: first call → `402` → payer grants stake+policy →
   proceed.
2. **Meter.** The creator's SDK calls `POST /charge {payer, amount, ref}` per event
   (per-listen, per-second, per-resolve, per-citation), **or** the facilitator
   subscribes to the creator's existing webhooks (Owncast `userJoined/Parted`,
   Navidrome scrobble, Jellyfin playback, RSSHub item) — the Canteen attachment
   shapes, unchanged.
3. **Batch.** The facilitator accumulates charges per `payer→creator` pair / per
   time window.
4. **Settle.** The facilitator submits **one batched settlement tx** authorized by
   the session key and validated against policy; the rail moves funds
   payer-stake → creator payout vault(s). Facilitator pays gas, deducts its fee.
5. **Withdraw / close.** Creator withdraws from its counterfactual payout vault
   (deploy-on-withdraw). Payer reclaims the unused stake remainder and/or revokes.

## How it fixes the open problems

| Problem (from prior docs) | Fix here |
|---|---|
| Per-payment gas ≈ 12.6% of a $0.01 call (`economics-review.md`) | **Batching** — one tx per N charges → gas/charge ≪ payment. |
| Relayer USDC-float fragility, `relayer_no_balance` hard-fails | Gas float moves to the **facilitator** and is amortized per *batch*, not per payment; far less fragile, and creators never touch it. |
| Mandatory 0.5% rent for ~no runtime work | Rail is **feeless**; fee moves to the facilitator, where real work is done and competition sets the price. |
| Centralizing middleman vs x402 ethos | Rail is permissionless + non-custodial; facilitators are **swappable** → no mandatory intermediary, no protocol rent. |
| Fragile self-hosted facilitator in creator deployment | Facilitator is **external and separate**; creators integrate with an SDK/HTTP call only. |

## Incorporates the earlier proposed fixes

- **Fix 1 — feeless / permissionless / pauseless / ownerless contract** → the
  **rail**.
- **Fix 2 — counterfactual vaults** (precomputed address, deploy-on-withdraw, salt
  that *commits to the owner*) → both the payer stake account and the creator
  payout vault.
- **Session key / policy + batching** → this design's core.

## x402 alignment

- **Wire:** standard x402 `402` at the edge for the grant/first interaction;
  subsequent draws are off the locked stake (an x402 deposit / "up-to" style
  scheme). Any standard x402 agent can initiate.
- **Both axes satisfied:** governance (feeless rail, swappable facilitators,
  non-custodial, permissionless) **and** micropayment economics (batching dissolves
  the per-event gas floor — the exact property x402/Canteen say sub-cent payments
  require).

## Open questions / risks

- **Compliance.** Non-custodial principal + bounded delegation keeps a facilitator
  off the custody hook. If *we* run a hosted facilitator holding session keys for
  many payers, we execute delegated (not custodied) authority — lighter than
  escrow, but get a legal read before the hosted tier ships.
- **Charge-auth model.** API-key (seamless) vs signed receipts (trust-minimized) —
  pick MVP tier; design the contract so receipts can be added without a wire break.
- **Session-key / policy mechanism.** Keep implementation-agnostic for now; the
  rail must enforce `{cap, rate, expiry, payees}` regardless of the underlying
  key/permission standard. (Candidate primitives exist; selection is a separate
  spike.)
- **Arc specifics.** On Arc, gas is already USDC, so gas-abstraction is a non-issue
  — the facilitator just needs a USDC float for *batch* gas, reimbursed via fee.
  The win on Arc is the **session-key/policy + batching**, not gas sponsorship.
- **Liveness / revocation.** Locked stake + short settlement windows bound the
  facilitator's served-but-unsettled exposure; define the window and the
  stake-lock/refund semantics precisely.
- **Build scope.** The facilitator owns a **ledger** (stakes, debits, batches,
  settlement, reconciliation, refunds). This is a real fintech backend — larger
  than the current middleware; scope it as its own workstream.

## Suggested next steps

- [ ] Decide MVP charge-auth tier (API-key vs signed receipts).
- [ ] Spec the rail contracts: payer stake account (lock + revoke + refund),
      on-chain policy enforcement, counterfactual payout vault (owner-committing
      salt) — feeless/ownerless.
- [ ] Define the session-key policy schema (`cap`, `rate`, `expiry`, `payees`,
      `facilitator`) and how the contract validates a batched settlement against it.
- [ ] Define the facilitator API (`/charge`, `/batch`, `/settle`) and the
      batching/settlement window.
- [ ] Pick the settlement primitive (deposit/channel) and write a gas model for
      batched settlement on Arc to confirm gas/charge ≪ price.
- [ ] Legal read on the hosted-facilitator posture before that tier.
