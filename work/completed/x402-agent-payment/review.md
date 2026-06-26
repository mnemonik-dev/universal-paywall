---
feature: x402-agent-payment
doc: spec-review
status: draft
created: 2026-06-16
reviewer: claude
scope: user-spec.md, tech-spec.md, diagrams/*, architecture.md, patterns.md
---

# Spec Review: x402-agent-payment

Review of the `dev` branch planning set (user-spec, tech-spec, diagrams, and the
edits to `architecture.md` / `patterns.md`). The branch is at the **planning
stage** — no implementation code yet.

## Bottom line

The spec is **well-structured and mostly relevant**, but not yet ready to
implement as written. It has **one central logic flaw (replay protection), a
payment-model contradiction (claims x402 / GatewayClient compatibility but
designs a non-x402 flow), and several internal inconsistencies** between the
user-spec, tech-spec, and diagrams.

---

## Relevance to the product

Mostly relevant, with one strategic deviation:

- The feature (agent gets 402 → pays → retries → 200, non-custodial split,
  pull-based withdrawals) is on-mission. Dropping the Stripe/human path for this
  slice is fine — it's explicitly out of scope.
- **Chain pivot Base → Arc is the big one.** `CLAUDE.md` says "x402 on **Base**".
  The spec moves to **Arc Network** and rewrites `architecture.md` to
  "chain-agnostic, Arc first." That may be the right call (Circle USDC native,
  low fees), but it is a significant decision that is not reflected consistently:
  - `CLAUDE.md` (top-level source of truth) was **not** updated — it still says
    Base, now contradicting `architecture.md`.
  - `architecture.md` is only **half-migrated**: the tech-stack row and External
    Integrations row now say Arc, but the **Payment Flows** section, the **data
    model** (`base_wallet`, `chain: 'base'`), and "Base event handlers" still say
    Base.

> Action: confirm the Base → Arc pivot is approved, then propagate it everywhere
> (CLAUDE.md, architecture.md flows + data model) or revert it.

---

## Logic issues (ranked)

### 1. Replay protection is contradictory and partly impossible — MUST FIX

- The contract guard is described as `usedTxSigs[txHash] = true` (tech-spec
  "Contract internally" step 6, contract-architecture diagram, patterns.md). **A
  contract cannot read its own transaction hash** — there is no EVM opcode for
  the enclosing tx hash. A mapping keyed on `txHash` cannot be populated from
  inside `pay()` / `payWithPermit()`. As written it is a no-op.
- The tech-spec also states "**no long-lived shared state in middleware — pure
  function wrapper**," yet the user-spec and error-flow diagram both require the
  middleware to return `tx_already_used`. The real attack — agent pays once
  on-chain, then replays the same valid `tx_hash` to get unlimited API responses
  — **can only be stopped with middleware-side state** (a store of consumed tx
  hashes) or a server-issued nonce bound to the payment. The spec rules that out,
  leaving no actual defense at the API layer.
- With EIP-2612 permit, on-chain double-spend is already prevented by USDC's
  permit **nonce**, so `usedTxSigs` is both redundant on-chain and ineffective
  for the API-level replay.

> Fix: redesign replay protection coherently. Either (a) middleware keeps a
> consumed-tx-hash store (drop the "pure function, no state" claim), or (b) bind
> each payment to a server-issued nonce/challenge that the agent includes, and
> verify it once.

### 2. Payment model contradicts the "x402 / GatewayClient compatible" claim — MUST FIX

- The design has the **agent** submit its own on-chain tx, then pass `tx_hash`;
  the middleware verifies the receipt (D2/D3). Standard **x402**
  (Coinbase/Circle) is the inverse: the client sends a *signed authorization* in
  `X-PAYMENT` and the **server/facilitator settles** it on-chain. D2 explicitly
  rejects that settlement model.
- Yet the user-spec claims "**any x402-compatible agent works**" and T10/T14 use
  Circle's `GatewayClient` as the test client, which implements the
  authorization-settlement model — not "submit-then-pass-hash." **The client and
  server models do not match.**
- Related: the custom `PAYMENT-REQUIRED` header + minimal JSON schema diverge
  from the real x402 402-body schema (`accepts[]`, `scheme`,
  `maxAmountRequired`, `resource`, `payTo`, `asset`, …).

> Fix: pick one model. Either adopt the standard x402 authorization-settlement
> flow (and the x402 header/body schema), or drop the "any x402 agent works" /
> GatewayClient claims and document this as a custom protocol.

### 3. User-spec / tech-spec / diagrams disagree with each other — MUST FIX

- **Function signature:** tech-spec uses
  `payWithPermit(developerId, amount, deadline, v, r, s)`; the user-spec
  acceptance criteria and the contract-architecture + error-flow diagrams still
  use the old `pay(developerId, amount, txSig)`. The permit redesign never
  propagated.
- **Field name:** user-spec/diagrams use `tx_sig` in `X-Payment`; tech-spec uses
  `tx_hash`. It is a hash, not a signature — `tx_sig` is misleading. Pick one
  (`tx_hash`).
- **Price format:** `'0.01'` (user-spec/diagrams) vs `"$0.01"` (tech-spec).
  Define the exact accepted format and parsing.

### 4. Network constants look like unverified placeholders — VERIFY

- `arc-mainnet chainId: 60808` is actually **BOB (Build on Bitcoin)**'s chain ID
  — almost certainly copy-pasted/wrong.
- `arc-testnet chainId: 5042002` and USDC `0x3600…0000` are unverified; the
  interview log itself lists "Arc RPC URL" and "USDC address on Arc" as **open
  gaps**, yet `networks.ts` presents them as concrete.
- D1 assumes Arc USDC supports EIP-2612 permit — verify (bridged USDC.e variants
  sometimes do not).

---

## Smaller notes

- Stray artifacts on `dev`: `test.txt` and the `5b4a375 test write` commit should
  be removed.
- `withdraw` reentrancy and fee rounding are correctly deferred to the security
  wave (T12). Good.
- Fee-config deviation (D4) is handled cleanly — acknowledged and `patterns.md`
  updated.
- The spec format (waves, per-task reviewers, verify-smoke commands, decision
  rationale, deviation tracking) is genuinely strong.

---

## Recommended pre-implementation checklist

- [ ] Confirm Base → Arc pivot; propagate across CLAUDE.md + architecture.md
      (flows + data model).
- [ ] Redesign replay protection (issue 1) and update tech-spec, patterns.md,
      diagrams.
- [ ] Resolve the x402 / GatewayClient payment-model contradiction (issue 2).
- [ ] Sync function signature, header field name, and price format across all
      three docs (issue 3).
- [ ] Verify Arc chain IDs, RPC URLs, USDC address, and EIP-2612 support; fill
      the interview-log gaps before T1.
- [ ] Remove `test.txt`.
