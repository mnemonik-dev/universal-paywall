# Universal Paywall — Patterns & Conventions

## Git Workflow

**Branch structure:**
- `main` — production-ready code, protected. Direct pushes blocked.
- `dev` — integration branch. PRs merge here first.
- `feat/*` — feature branches off `dev`
- `fix/*` — bug fix branches off `dev`
- `claude/*` — AI-agent work branches

**Commit convention:** Conventional Commits with scope:
```
feat(middleware): add withPaywall() for Express
fix(contracts): correct fee basis points calculation
feat(dashboard): transaction breakdown by payer type
chore(deps): bump viem to 2.x
```

**PR flow:** `feat/*` → `dev` → reviewed → `main` for release.

## Testing Requirements

- Unit tests required for payment logic (x402 verification, Stripe session creation, fee calculation)
- Contract tests via Hardhat — test PaymentSplitter split amounts
- Integration tests for the full x402 flow (local Base fork via Hardhat network)
- Dashboard: Playwright E2E for critical paths (login, view transactions)

## Security Gates

**Pre-commit:**
- gitleaks — no secrets committed
- TypeScript typecheck
- ESLint

**Pre-push / CI:**
- Full test suite
- Contract audit checklist before mainnet deploy

## Code Patterns

_Filled during development as patterns emerge._

## Business Rules

_Filled during development as rules are implemented._

## Smart Contract Rules

- Platform fee is **50 basis points (0.5%)** — hardcoded in PaymentSplitter, not configurable per-developer in MVP
- Only USDC on Base in MVP — contract validates token address
- Developer wallet address registered at onboarding — stored in SQLite, passed to contract verification
- Nonce tracking to prevent x402 replay attacks
