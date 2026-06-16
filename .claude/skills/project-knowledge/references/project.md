# Universal Paywall — Project Overview

## What it is

Universal Paywall is an open-core payment infrastructure that puts a monetization layer in front of any HTTP service. It handles payments from both AI agents (via the x402 protocol) and human users (via Stripe), so service owners get paid regardless of who — or what — is calling their API.

## Target Audience

Three roles:

- **Developer / service owner** — integrates the middleware npm package to protect their endpoints. Registers on the hosted platform to unlock fiat support and the revenue dashboard.
- **Human user** — hits a paywalled endpoint, gets redirected to a hosted checkout page, pays by card, returns to the service.
- **AI agent** — encounters an HTTP 402 response, signs a USDC micropayment authorization via x402, retries — access granted automatically.

## Core Problem

Monetizing an API today requires wiring up Stripe for humans *and* building a separate crypto payment path for agents — two completely different systems. Universal Paywall collapses these into one middleware call.

## Business Model

Open-core:

- **Free tier (open source):** TypeScript middleware on npm. Self-hosted x402 on Base. No platform involvement, no fee taken.
- **Paid hosted tier:** Developer routes payments through the Universal Paywall platform. We take **0.5 %** of every transaction automatically — via Stripe Connect for fiat and a PaymentSplitter smart contract on Base for crypto. In exchange: hosted checkout page, Stripe for humans, revenue dashboard.

## Key Features (MVP)

| Feature | Priority | Notes |
|---|---|---|
| TypeScript middleware (`withPaywall()`) | Critical | npm package, wraps any HTTP handler |
| x402 payment flow for AI agents | Critical | Base chain, USDC, non-custodial split |
| PaymentSplitter smart contract on Base | Critical | Auto-splits 0.5% to platform, rest to developer |
| Stripe Connect hosted checkout for humans | Critical | Redirect flow, platform fee via `application_fee_amount` |
| Developer onboarding | Critical | OAuth → Stripe Connect → Base wallet → API key |
| Revenue dashboard | Important | Transactions, revenue, agents vs humans breakdown |

## Out of Scope (MVP)

- Multi-chain x402 (only Base in MVP; Solana, Ethereum mainnet — post-MVP)
- Subscription / recurring billing
- White-labeling of checkout page
- Webhooks for developers
- Multi-currency (USDC only for x402; Stripe handles currency conversion)
- Refunds management UI
- Multi-member developer accounts
- Native tokens (ETH, SOL) — USDC only
- Fiat on-ramp for crypto payments
- Rate limiting / quota management (pay-per-N-calls model)

## Post-Launch Ideas

- Solana x402 support
- Ethereum mainnet support
- Webhook delivery for payment events
- White-label checkout
- Team accounts
- Subscription billing model
- The Graph indexer for on-chain analytics
