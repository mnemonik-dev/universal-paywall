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
| `BASE_RPC_URL` | Alchemy/Infura endpoint for Base |
| `PLATFORM_WALLET_ADDRESS` | Our wallet that receives 0.5% x402 fees |
| `PAYMENT_SPLITTER_ADDRESS` | Deployed PaymentSplitter contract on Base |
| `JWT_SECRET` | API key signing |
| `GOOGLE_CLIENT_ID/SECRET` | OAuth |
| `DATABASE_PATH` | SQLite file path (default: `/data/paywall.db`) |

## Smart Contract Deployment

- Contracts deployed to **Base mainnet** via Hardhat + deploy script
- Contract address pinned in environment variables after deploy
- Audit required before mainnet deployment
- Base Sepolia used for staging/testing

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
