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

- **Build-time codegen for monorepo-relative data files.** The middleware bundle must not `readFileSync` files at runtime — paths that resolve inside the monorepo (e.g. `../../../contracts/scripts/foo.json`) break when the bundle is installed under `node_modules/`. Pattern: keep the JSON as the single source of truth, add a small `prebuild` codegen script that emits a TS module under `src/generated/`, import the const at top-level. tsup tree-shakes and inlines. The committed `src/generated/` file is intentional (do not gitignore it) — see comment in root `.gitignore`. Example: `packages/middleware/scripts/generate-arc-testnet-usdc-domain.ts`.
- **Sentinel-comment patching for deployed-address propagation.** Smart-contract addresses produced by a live deploy can't be hard-coded ahead of time and must NOT be hand-edited into source. Pattern: in `packages/middleware/src/networks.ts`, the address literals carry a trailing sentinel comment (`/* deploy-script:factoryAddress */`, `/* deploy-script:vaultImplAddress */`). The post-deploy script (`contracts/scripts/post-deploy.ts`) regex-matches the sentinel and substitutes the address from the forge broadcast JSON. Sentinel format must survive a prettier-style change of quote style (both `'` and `"` accepted).
- **`OpaqueRelayerKey` wrapper for sensitive hex.** Raw private keys (`0x…64hex`) are wrapped in an opaque class at the env-read boundary so they never appear in stack traces or unredacted logs. Never accept a bare hex string from the environment in feature code — pass through `new OpaqueRelayerKey(env.PAYWALL_RELAYER_KEY)` first.

## Business Rules

_Filled during development as rules are implemented._

## Smart Contract Rules

- Platform fee is **configurable** via `factory.setFeeBps(bps)` — owner-only, default 50 bps (0.5%), hard cap 1000 bps (10%). All deployed vaults read this value from the factory at withdraw time.
- Only USDC in MVP — `usdc` address is immutable on factory, propagated to vaults.
- **Architecture is factory + per-developer vaults via EIP-1167 minimal proxy.** `factory.register()` deploys a `PaymentVaultImpl` clone at a CREATE2-deterministic address derived from `msg.sender` (the developer EOA). Vault is initialized with `developer = msg.sender` (immutable). Per-developer vaults eliminate cross-developer payment-attribution risk and remove the open-registration griefing surface.
- 402 `payTo` field is the developer's vault address — computable off-chain via `factory.computeVaultAddress(developer)` without an RPC call.
- **EIP-3009 `transferWithAuthorization`** is the on-chain primitive (matches x402 standard, supported natively by Circle USDC). EIP-2612 permit is **not** used. Middleware (facilitator) calls `USDC.transferWithAuthorization(from, to=vault, value, validAfter, validBefore, nonce, v, r, s)` directly — no contract wrapper needed at settle time; vault is a passive ERC-20 receiver.
- Vault `withdraw()` (callable only by `developer`, `nonReentrant`) reads `usdc.balanceOf(this)` as gross, computes `fee = gross * feeBps / 10000`, sends `gross - fee` to developer and `fee` to `factory.platformTreasury()` in one tx.
- Replay protection has two layers:
  - On-chain: USDC's own `authorizationState[from][nonce]` mapping (built into EIP-3009)
  - API-level: middleware maintains an in-memory consumed-nonce store with synchronous check-and-insert and TTL eviction (nonce expires when `validBefore` passes). Single-process scope — multi-instance support (Redis-backed) is post-MVP.
- Factory uses `Pausable`. When paused: middleware refuses to settle (returns 402 `"error": "paused"`); `withdraw` on already-deployed vaults always works (developers never locked out).
- Wallet rotation / unregister is **not supported** in MVP — if the registered developer wallet is compromised, accumulated USDC in vault is at risk. Post-MVP: add `vault.rotateDeveloper(newDeveloper)` with signed challenge.
- Recommended `Ownable2Step` (OZ 5.x) on factory + multisig as initial owner to mitigate owner-key compromise.
