# Universal Paywall

Open-core paywall for HTTP services. Handles payments from AI agents (x402 on Arc Network — Testnet for MVP; chain-agnostic design) and human users (Stripe Connect). Service owners get paid from both.

## Project Structure

```
packages/middleware/   # @universal-paywall/middleware — npm package
apps/api/              # Fastify backend (onboarding, checkout, webhooks, dashboard API)
apps/dashboard/        # Next.js developer dashboard
contracts/             # Solidity PaymentSplitter (Arc Network)
```

## Key Commands

```bash
# Install all dependencies
npm install

# Run API locally
npm run dev --workspace=apps/api

# Run dashboard locally
npm run dev --workspace=apps/dashboard

# Run contract tests
cd contracts && npx hardhat test

# Deploy contracts (Arc Testnet staging)
cd contracts && npx hardhat run deploy/01_deploy_splitter.ts --network arcTestnet
```

## Project Knowledge

Architecture, patterns, deployment, and UX guidelines are in `.claude/skills/project-knowledge/references/`.

## Default Branch

`main` — production. Feature branches off `dev`. PRs go to `dev` first.
