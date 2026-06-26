# Universal Paywall — Deployment

## Platform

**Hetzner VPS** — single server for MVP. Docker Compose manages all services.

Rationale: full control, cost-effective, no vendor lock-in, easy to migrate later.

## Services (Docker Compose)

```yaml
services:
  api:       # Fastify backend + SQLite file mount
  dashboard: # Next.js (or served as static build via nginx)
  nginx:     # Reverse proxy, TLS termination (Let's Encrypt)
```

SQLite database lives as a mounted volume on the VPS. Backup via daily `cp` to Hetzner Object Storage.

## Environments

| Environment | URL | Branch | Notes |
|---|---|---|---|
| Production | pay.universalpaywall.com | `main` | Manual deploy trigger |
| Dev/Staging | dev.universalpaywall.com | `dev` | Auto-deploy on push |

## Deployment Triggers

- Push to `dev` → auto-deploy to staging via GitHub Actions
- Push to `main` (after PR merge) → manual approval → deploy to production

## CI/CD (GitHub Actions)

```
On PR to dev/main:
  → typecheck + lint
  → unit tests
  → contract tests (Hardhat)
  → E2E (Playwright, staging)

On merge to main (after approval):
  → SSH to Hetzner VPS
  → docker compose pull && docker compose up -d
```

## Environment Variables

Reference `.env.example` for full list. Critical variables:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Connect platform key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `ARC_RPC_URL` | Arc Testnet RPC endpoint (default: `https://rpc.testnet.arc.network`, fallback: `https://5042002.rpc.thirdweb.com`) |
| `PAYWALL_RELAYER_KEY` | Private key (`0x…`) for the facilitator relayer that submits `transferWithAuthorization` and pays gas in USDC. The deployer EOA also needs USDC to deploy contracts (Arc Testnet charges gas in USDC, not ETH). |
| `PLATFORM_TREASURY_ADDRESS` | Address that receives platform fees from per-developer vaults on `withdraw()` |
| `PAYMENT_SPLITTER_FACTORY_ADDRESS` | Deployed `PaymentSplitterFactory` contract on Arc Testnet |
| `JWT_SECRET` | API key signing |
| `GOOGLE_CLIENT_ID/SECRET` | OAuth |
| `DATABASE_PATH` | SQLite file path (default: `/data/paywall.db`) |

## Smart Contract Deployment

- `PaymentSplitterFactory` + `PaymentVaultImpl` deployed to **Arc Testnet** via Foundry (`forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast`). Arc Mainnet — when Circle launches.
- Factory constructor takes exactly three args `(IERC20 _usdc, address _platformTreasury, uint16 _initialFeeBps)`; the vaultImpl is created INSIDE the factory constructor (D3, surfaced in broadcast at `transactions[0].additionalContracts[0].address`) and exposed via `factory.vaultImpl()`.
- After deploy, `contracts/scripts/post-deploy.ts` reads `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json` and sentinel-patches `packages/middleware/src/networks.ts` (lines marked `/* deploy-script:factoryAddress */` and `/* deploy-script:vaultImplAddress */`). The address from `PAYMENT_SPLITTER_FACTORY_ADDRESS` env is a runtime override; the canonical address lives in `networks.ts`.
- Arcscan source verification: forge's `--verify` flag requires a `verifier_url` in `foundry.toml` — currently NOT configured, so the manual fallback is the canonical path: `forge verify-contract --chain 5042002 --verifier blockscout --verifier-url https://testnet.arcscan.app/api …` for both factory (with constructor args via `cast abi-encode`) and vaultImpl (no args).
- Audit required before any mainnet deployment.
- Recommend `Ownable2Step` + multisig (e.g. Safe) as factory owner at deploy time; not enforced in contract.

### Live Arc Testnet deployment (2026-06-26, feature x402-agent-payment)

| Artefact | Address |
| --- | --- |
| Factory | [`0x028442a366fd124a9e953c90dae58afb8b8db9d8`](https://testnet.arcscan.app/address/0x028442a366fd124a9e953c90dae58afb8b8db9d8) (verified) |
| VaultImpl | [`0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45`](https://testnet.arcscan.app/address/0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45) (verified) |
| Owner / deployer EOA | `0x1a06116DA33b3e5c7a7f98bC8593Ef6506895B72` |
| Platform treasury | `0xBD845888a6aFd2d0193850F24F8944f2DDF2C409` |
| `feeBps` | `50` (0.5%) |

## npm Package

- Public registry: [`@universal-paywall/middleware`](https://www.npmjs.com/package/@universal-paywall/middleware).
- First stable release: `0.0.1` — tag `latest`. Earlier `0.0.1-alpha.0` (broken — runtime path read for the T3 USDC-domain artefact failed in clean installs) and `0.0.1-alpha.1` (fixed via build-time codegen) remain on the registry; consumers should always install `0.0.1` or later.
- Bundle is ESM-only, `engines.node: ">=20"`, `dist/` only (no source, no tests, no sourcemap). The `prebuild` script runs `tsx scripts/generate-arc-testnet-usdc-domain.ts` to mirror `contracts/scripts/arc-testnet-usdc-domain.json` into `src/generated/arc-testnet-usdc-domain.ts` so the published bundle is self-contained.
- Publish pipeline: `prepublishOnly` = `clean && build && test`. Provenance is best-effort — gated on (npm ≥ 9.5) AND `$GITHUB_ACTIONS` set; locally published without provenance, CI publishes carry an SLSA attestation visible via `npm audit signatures`.
- Publish requires npm 2FA (one-time password). Run the publish command from the operator workstation with `--access=public`; do NOT add `--tag=alpha` for stable releases.
- Git tags follow `middleware-vX.Y.Z` (e.g. `middleware-v0.0.1`). Tag the release commit only AFTER `npm view ...@<version> dist.tarball` resolves, so the tag never points at a non-existent version.

## Monitoring

Not yet configured. Planned post-MVP:
- Uptime check (UptimeRobot or similar)
- Error alerting (Sentry)
- VPS metrics (Hetzner built-in)

## Rollback

```bash
# Rollback to previous image
docker compose down
docker compose up -d --scale api=1 <previous-image-tag>
```

SQLite backup restored from Hetzner Object Storage if needed.
