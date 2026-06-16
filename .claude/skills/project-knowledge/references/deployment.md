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
| `PAYWALL_RELAYER_KEY` | Private key (`0x…`) for the facilitator relayer that submits `transferWithAuthorization` and pays gas in USDC |
| `PLATFORM_TREASURY_ADDRESS` | Address that receives platform fees from per-developer vaults on `withdraw()` |
| `PAYMENT_SPLITTER_FACTORY_ADDRESS` | Deployed `PaymentSplitterFactory` contract on Arc Testnet |
| `JWT_SECRET` | API key signing |
| `GOOGLE_CLIENT_ID/SECRET` | OAuth |
| `DATABASE_PATH` | SQLite file path (default: `/data/paywall.db`) |

## Smart Contract Deployment

- `PaymentSplitterFactory` + `PaymentVaultImpl` deployed to **Arc Testnet** via Hardhat for MVP. Arc Mainnet — when Circle launches.
- Factory address pinned in `PAYMENT_SPLITTER_FACTORY_ADDRESS` after deploy.
- Audit required before any mainnet deployment.
- Recommend `Ownable2Step` + multisig (e.g. Safe) as factory owner at deploy time; not enforced in contract.

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
