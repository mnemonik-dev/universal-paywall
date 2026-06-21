---
feature: x402-agent-payment
doc: economics-review
status: draft
created: 2026-06-17
reviewer: claude
scope: PaymentVaultImpl.sol, settle.ts, core.ts, tech-spec.md, decisions.md, external-analysis-response.md
relates_to: review.md, external-analysis.md, external-analysis-response.md
---

# Economics Review: who pays whom, and does the model close?

Traces the actual money + gas flow in the current `dev` implementation and asks
whether the unit economics are internally consistent. Conclusion up front: the
**payment custody design is sound, but the gas/fee economics do not close** — at
the headline price point gas is ~25× the platform fee, the party that pays gas is
not the party that earns, and the self-hosted relayer is operationally fragile.

## Verified money + gas flow

Per-payment, end to end (verified against code):

1. **Agent signs** an EIP-3009 `transferWithAuthorization` **offchain** (USDC:
   agent → developer's vault). The agent pays **no gas**.
2. **Relayer broadcasts** that authorization on-chain
   (`settle.ts` → `USDC.transferWithAuthorization`). On Arc, gas is paid **in
   USDC** out of the relayer's own balance. The relayer key (`PAYWALL_RELAYER_KEY`
   / `OpaqueRelayerKey`) is supplied by the **consumer** of the middleware — i.e.
   the **developer self-hosts the facilitator** (tech-spec L14/16/136).
3. **The full payment accrues in the vault** (`PaymentVaultImpl`, a passive USDC
   receiver). No fee is taken at payment time.
4. **On `withdraw()`** (`PaymentVaultImpl.sol:80–99`) the vault splits the balance:
   `net → developer`, `fee → platformTreasury`, where
   `fee = gross * feeBps / 10000` (default **50 bps = 0.5%**).
5. **Nothing reimburses the relayer's gas.** The contract only does the
   developer/platform split; there is no gas line item anywhere.

### Who pays whom

| Party | Pays | Receives |
|---|---|---|
| Agent | the price (e.g. 0.01 USDC) | the resource |
| Relayer (= developer in self-host) | **gas, in USDC, unreimbursed** | nothing |
| Developer's vault | — | full payment (gross) |
| Developer (on withdraw) | 0.5% platform fee | `gross − fee` |
| Platform | nothing at runtime | 0.5% on withdraw |

## The holes

### 1. Gas ≫ fee, by ~25× at the headline price

Task 3 spike (`decisions.md`, Task 3) measured `transferWithAuthorization` at
**1212–1290 micro-USDC**. Against a **0.01 USDC = 10,000 micro-USDC** payment that
is **~12–13%** of the payment. The platform fee is **0.5%**.

| Item | Per $0.01 payment | % of payment |
|---|---|---|
| Gas (measured) | ~1,250 micro-USDC | **~12.6%** |
| Platform fee (0.5%) | 50 micro-USDC | 0.5% |
| To developer (net) | ~9,950 micro-USDC | 99.5% (before their own gas) |

The "$0.01 per call" example and the fee model are not reconcilable as-is.

### 2. The gas-payer and the fee-earner are decoupled

There is no mechanism to deduct gas from the settled amount to repay the
facilitator. So the runtime cost-bearer (relayer) and the revenue-earner
(platform) are different parties:

- **Self-host (what's coded):** the developer pays ~12.6% gas **and** the 0.5%
  skim; nets ~87% per payment, bears all operational cost. The platform earns
  0.5% for zero runtime work.
- **Platform-hosted (the deferred "paid tier"):** the platform pays ~12.6% gas
  and earns 0.5% → **loses ~12% on every payment.** The response doc
  (`external-analysis-response.md` §E.3) says the fee exists "for sustainability
  of the hosted tier," but 0.5% cannot cover 12.6% gas. Break-even needs a
  >12.6% fee — worse than Stripe, which kills the value proposition.

### 3. The self-hosted relayer is operationally fragile

`settle.ts` reads `USDC.balanceOf(relayer)` before settling and returns
`relayer_no_balance` when it is below `gasEstimate × 2`; on that path **the
payment is not settled and the resource is not served**. Auto-refill is
explicitly out of scope (tech-spec L529). So a developer must run a hot key,
pre-fund a USDC gas float, and monitor it — or paid requests silently start
failing. This contradicts the "add one line of code and get paid" DX promise in
`CLAUDE.md` / `user-spec.md`.

### 4. The "free tier" (no vault, no fee) is described but NOT implemented

`external-analysis-response.md` §E.3 claims: *"free tier can set
`payTo = developerEoa` directly, paid tier uses the vault."* The code does not do
this. `core.ts:439–518` always resolves `payTo` from
`factory.vaults(developerEoa)`; if the vault is not deployed it returns
`vault_not_deployed` and the agent must wait. **The vault — and therefore the
0.5% fee — is mandatory in the current implementation.** There is no EOA-direct
path.

### 5. `withdraw()` has no minimum amount — dust withdrawals are gas-negative

`PaymentVaultImpl.withdraw()` (`PaymentVaultImpl.sol:80–99`) reverts only when the
balance is exactly zero (`NoBalance`). Any non-zero balance can be withdrawn —
including dust. But `withdraw()` is itself an on-chain transaction, and on Arc its
gas is paid **in USDC by the developer who calls it**. So withdrawing a small
balance can cost more in gas than it releases:

- The withdraw does **two** `safeTransfer`s (developer + treasury), so its gas is
  in the same order as — or higher than — a settlement tx (~1,250 micro-USDC from
  the Task 3 spike). Withdrawing anything below roughly that amount is
  **net-negative** for the developer.
- A naive integrator (or an automated "withdraw on every payment" loop) can burn
  the entire payout on gas, one withdraw at a time.

**There should be a minimum-withdrawal threshold.** Options:

1. **On-chain guard:** revert if `gross < MIN_WITHDRAWAL` with a dedicated error
   (e.g. `BelowMinWithdrawal`). Make it a constant or an owner-set,
   per-network-tunable value on the factory (gas varies by chain), so the floor
   can track real gas cost.
2. **Off-chain guard:** the middleware / dashboard refuses to surface a withdraw
   action until the balance clears a configured floor, and documents the
   gas-vs-amount tradeoff.

Either way it must be **explicit** — the natural accumulate-then-withdraw pattern
(which is also what keeps per-payment economics tolerable) should be encoded, not
left to the developer to rediscover by losing money to gas. A minimum also blunts
dust-griefing (spamming a vault with 1-micro-USDC settlements to make withdrawals
perpetually uneconomic).

## What is genuinely sound (not everything is broken)

- **Non-custodial vault** (`PaymentVaultImpl`): USDC moves agent → developer's
  vault directly; the platform never custodies funds. Good, and it sidesteps
  money-transmission concerns for the self-host case.
- **EIP-3009 facilitator** is the correct x402 settlement model — this fixed the
  earlier "agent submits its own tx" inversion flagged in `review.md` #2.
- **The gas problem is acknowledged**: Risks row in `tech-spec.md` (L496) + the
  Task 3 measurement gate + a deferred `x402-batched-settlement` plan.

The gap is that the deferral is incomplete: **batching** (which fixes gas) was
deferred, while **both** the 0.5% fee **and** the $0.01 example were kept. Per
the numbers above, per-payment settlement is only viable for **low-volume,
higher-priced** calls — not the micropayment use case that is the headline.

## Options (decide the paradigm deliberately)

1. **Batch settlement** (the deferred plan; the Canteen thesis). Amortize one
   on-chain tx over N authorizations so gas-per-payment falls well under 0.5%.
   This is the only option that makes "$0.01 + a small fee" coherent — arguably it
   should not be post-MVP if micropayments are the product.
2. **Charge gas to the agent.** Deduct a gas/relayer fee from the settled amount
   so the facilitator is made whole. Turns gas from an unreimbursed cost into a
   priced line item; composes with either tier.
3. **Raise the viable price floor.** If staying per-payment for MVP, state plainly
   that the economic unit is ~$0.10–$1+, not $0.01, and align all docs/examples.
4. **Decide who hosts the relayer** and size the fee to cover its gas in that
   model. Today it is coded for self-host (fragile + misaligned) and hand-waved
   for hosted (loss-making).
5. **Implement or retract the "free tier."** Either ship the `payTo = developerEoa`
   EOA-direct path the response doc describes, or remove the claim and document
   that the vault + fee are mandatory.

## Suggested follow-ups

- [ ] Pick a target economic unit (price floor) and reconcile every doc/example to
      it.
- [ ] Decide batching now vs. post-MVP given the 12.6% measured gas ratio — and if
      post-MVP, gate the headline price example accordingly.
- [ ] Add a relayer-gas-reimbursement line item, or document explicitly that the
      facilitator subsidizes gas and why.
- [ ] Resolve the relayer-hosting question (self vs platform) and align the fee.
- [ ] Implement the EOA-direct free tier or retract it from
      `external-analysis-response.md` §E.3.
- [ ] Add a minimum-withdrawal threshold (on-chain guard or off-chain gate) so
      dust withdrawals can't go gas-negative; size it to real per-chain gas cost.
