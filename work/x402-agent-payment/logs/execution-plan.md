# Execution Plan: x402-agent-payment

**Created:** 2026-06-17
**Feature dir:** `work/x402-agent-payment/`
**Total waves:** 13
**Total tasks:** 17
**Team name:** `x402-agent-payment`

---

## Wave 1 — Foundation (parallel: T1, T2)

### Task 1: Monorepo scaffolding (ESM-only)
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `npm install && npm run lint && npm run build --workspace=packages/middleware`

### Task 2: Foundry setup
- **Skill:** infrastructure-setup
- **Reviewers:** code-reviewer, security-auditor, infrastructure-reviewer
- **Verify-smoke:** `cd contracts && forge build`

## Wave 2 — Arc Testnet USDC spike (depends on T2)

### Task 3: Verify Arc Testnet USDC supports EIP-3009 + measure gas
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && npx tsx scripts/verify-usdc-eip3009.ts`

## Wave 3 — Contracts (depends on T1, T2)

### Task 4: Factory + Vault contracts
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && forge build` (compilation clean)

## Wave 4 — Contract tests (depends on T4)

### Task 5: Contract tests (Foundry)
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `cd contracts && forge test`

## Wave 5 — Middleware primitives (depends on T1, T3)

### Task 6: Types, NETWORKS, x402 codec, errors, relayer-key, replay-store
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=@universal-paywall/middleware` (unit tests for codec/errors/replay)

## Wave 6 — Verify + Settle (depends on T4, T6)

### Task 7: Verify + Settle
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** middleware unit tests pass

## Wave 7 — Core orchestrator (depends on T6, T7)

### Task 8: Core orchestrator + adapters + index
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** middleware unit tests pass

## Wave 8 — Tests + Deploy script (parallel: T9, T11; depends on T6,T7,T8 and T4,T8)

### Task 9: Middleware unit tests (incl. adapter unit tests)
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** `npm test --workspace=@universal-paywall/middleware` — full unit suite green

### Task 11: Deploy script (forge + TS post-step) + register CLI + README
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** local deploy against anvil, register CLI tests pass
- **Verify-user:** ⚠️ User walks the README onboarding (faucet → register → install → 402) and reports results

## Wave 9 — Integration + e2e (depends on T5, T8, T9)

### Task 10: Forked integration + Arc Testnet e2e (gated)
- **Skill:** code-writing
- **Reviewers:** code-reviewer, security-auditor, test-reviewer
- **Verify-smoke:** forked Arc tests pass; live e2e gated behind env var

## Wave 10 — Audit (parallel: T12, T13, T14; reviewers: none)

### Task 12: Code Audit
- **Skill:** code-reviewing
- **Reviewers:** none (auditor IS the review)

### Task 13: Security Audit
- **Skill:** security-auditor
- **Reviewers:** none

### Task 14: Test Audit
- **Skill:** test-master
- **Reviewers:** none

**On findings:** spawn ad-hoc fixer (code-writing skill) with the auditors who flagged as reviewers; standard review protocol (max 3 rounds).

## Wave 11 — Pre-deploy QA (depends on T12, T13, T14)

### Task 15: Pre-deploy QA
- **Skill:** pre-deploy-qa
- **Reviewers:** none
- **Verify-smoke:** all acceptance criteria from user-spec + tech-spec verified

## Wave 12 — Deploy (depends on T15)

### Task 16: Deploy to Arc Testnet + npm publish (alpha)
- **Skill:** deploy-pipeline
- **Reviewers:** code-reviewer, security-auditor, deploy-reviewer
- **Verify-smoke:** contracts verified on arcscan, npm package published as `0.0.1-alpha.0`

## Wave 13 — Post-deploy verification (depends on T16)

### Task 17: Post-deploy verification
- **Skill:** post-deploy-qa
- **Reviewers:** none
- **Verify-smoke:** AVP runs against deployed contracts + published package

---

## User checks required

- [ ] **Task 11 (Wave 8):** Walk the README onboarding section verbatim as a new developer. Verify faucet step, register CLI, install + run, 402 response.
- [ ] **After Final Wave:** Final review of decisions.md, audit reports, and Arc Testnet deployment.

---

## Risks / Notes

- T3 is a **spike**: if Arc Testnet USDC does NOT implement EIP-3009 transferWithAuthorization, the entire flow needs redesign — escalate to user.
- T11's `verify-user` blocks Wave 9 progress until user confirms onboarding works (or accepts deferral).
- T10's live Arc Testnet e2e is gated — may need user-provided RPC + funded key.
- T15 spec says "requires user approval of tech-spec" — confirm tech-spec is approved before T15 starts.
