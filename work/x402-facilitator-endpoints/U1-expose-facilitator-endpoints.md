---
status: pending
priority: P1
size: M
created: 2026-08-22
related:
  - "mnemonik-xyz/monorepo — work/x402-v2-conformance/scope.md (the consumer side)"
  - "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md §7"
---

# U1 — Expose the facilitator contract over HTTP

## Why

Universal Paywall already implements x402 `exact` correctly. What it does not do
is expose that implementation over the wire.

Today the only way to be a resource server on this rail is to **import our
TypeScript** — `@universal-paywall/middleware` or `@universal-paywall/resource-adapter`.
That excludes every non-TypeScript service. mnemonic-mcp is Rust, and it worked
around the gap by calling the facilitator's internal REST API
(`POST /v1/payments/settle`) one layer beneath the x402 surface, then
re-implementing payment badly on top. The result was a bespoke 402 body, a
non-x402 `tx_sig` payment model, and the conformant path wired as a 500.

x402 specifies the facilitator API as **HTTP** precisely so resource servers in
any language can delegate chain work. We have the logic; it just isn't behind a
port.

This task unblocks any non-TS resource server, not only mnemonic.

## Scope

Add three routes — `POST /verify`, `POST /settle`, `GET /supported` — over logic
that already exists.

### The mapping is near 1:1

| Existing | Signature | x402 response |
| --- | --- | --- |
| `verifyEip3009Authorization` (`packages/middleware/src/verify.ts:98`) | `(payload, opts) -> {ok:true, recoveredFrom}` \| `{ok:false, reason}` | `{isValid:true, payer}` \| `{isValid:false, invalidReason, payer}` |
| `settleOnChain` (`packages/middleware/src/settle.ts:302`) | `(payload, recoveredFrom, opts) -> {ok:true, txHash, payer}` \| `{ok:false, reason}` | `{success:true, payer, transaction, network}` \| `{success:false, errorReason, payer, transaction, network}` |

Request envelope for both is `{x402Version, paymentPayload, paymentRequirements}`.
Our `PaymentPayload` type is already the right shape.

### The five actual pieces of work

1. **Decode the x402 request envelope** and validate `x402Version`.
2. **Build `VerifyOptions` / `SettleOptions` from `paymentRequirements`**, not
   from static middleware config. This is the only genuinely new logic: today
   `expectedVaultAddress`, `expectedNetwork` and `maxAmountRequired` come from
   the resource server's own configuration, but x402 passes them per request.
3. **Map reason strings to spec error codes** — `VerifyReason` / `SettleReason`
   onto `insufficient_funds`, `unsupported_scheme`, and the rest of §8.
4. **`/settle` must run verify internally.** `settleOnChain` needs
   `recoveredFrom`, which only verify produces. The spec expects `/settle` to be
   self-sufficient.
5. **`/supported`** enumerates the `NETWORKS` registry × `exact`, plus the
   `signers` map (CAIP-2 pattern → relayer address).

## Two decisions to make first

**Where the routes live.** `packages/facilitator` currently depends only on
`@noble/hashes` and `viem`; `middleware` is standalone; `resource-adapter`
depends on `facilitator`. Putting `/verify` and `/settle` in `facilitator` means
`facilitator -> middleware`, which needs checking against that existing
direction. Options: host the routes in `middleware` instead, or extract the
verify/settle core into a shared internal module both can use.

**Auth on `/supported`.** `session-server.ts` gates every route after
`/health` and `/.well-known/payment-receipt-key` behind `authorized(req, keys)`.
`/verify` and `/settle` should stay authenticated. `/supported` is a discovery
endpoint and probably should not be — decide deliberately rather than inherit
the blanket gate.

## Non-scope

- **v2 migration.** Everything here is `x402Version: 1`, which the spec still
  publishes alongside v2 (`x402-specification-v1.md` and `transports-v1` are
  both current). Moving to v2 header transport is U2 and is independent.
- **The `stake` scheme.** Keep `/supported` advertising `exact` only. `stake` is
  unregistered, and hosted Phase 1 is exact-only anyway
  (`packages/facilitator/src/session-service.ts:42`). Mapping it onto the
  standard `batch-settlement` scheme is U3.
- **Retiring `/v1/quotes`, `/v1/sessions`, `/v1/payments/*`.** They serve the
  existing approval-UI flow. Add alongside; do not replace.

## Acceptance criteria

- A resource server written in a language other than TypeScript completes
  verify → resource → settle against a live facilitator with **no
  `@universal-paywall/*` import**.
- `/verify` is read-only: it commits no payment state and writes nothing
  on-chain (spec §7.1).
- `/settle` is idempotent per authorization — a repeated call for the same
  payload never produces a second charge.
- Failure reasons surface as spec error codes, not internal strings.
- `/supported` lists only kinds the facilitator can actually settle, so a
  resource server can populate `accepts[]` from it rather than from config.
- Existing `/v1/*` consumers are unaffected.

## Downstream

Blocks `M2` in mnemonik-xyz/monorepo
(`work/x402-v2-conformance/tasks/M2-delegate-to-facilitator.md`). M2 cannot be
verified end to end until these endpoints exist, and stubbing them on the
consumer side would re-create the mock problem that work exists to remove.
