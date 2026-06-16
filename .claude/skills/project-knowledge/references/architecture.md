# Universal Paywall — Architecture

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Middleware (npm)** | TypeScript | Matches JS ecosystem where most API servers live; compatible with arc-nanopayments patterns |
| **Backend API** | Node.js + Fastify | TypeScript-native, fast, minimal boilerplate for REST + webhook handlers |
| **Frontend dashboard** | Next.js | SSR + API routes in one project; fast to build admin UI |
| **Smart contract** | Solidity + Hardhat | Base = EVM; standard toolchain; OpenZeppelin PaymentSplitter as foundation |
| **Database** | SQLite | Zero config, single file, sufficient for MVP on one VPS; same pattern as mnemonik monorepo |
| **x402 SDK** | @circle-fin/x402-batching | Battle-tested in arc-nanopayments, handles x402 protocol details |
| **Fiat payments** | Stripe Connect | Platform model: auto-split via `application_fee_amount`, Stripe handles KYC/compliance |
| **Blockchain** | Base (EVM, USDC) | Low fees, EVM-compatible, USDC native support, Circle ecosystem |
| **Hosting** | Hetzner VPS | Cost-effective, full control, Docker-based |
| **CI/CD** | GitHub Actions | |
| **Containers** | Docker + Docker Compose | |

## Project Structure

```
universal-paywall/
├── packages/
│   └── middleware/          # npm package: @universal-paywall/middleware
│       ├── src/
│       │   ├── index.ts     # withPaywall() export
│       │   ├── x402.ts      # x402 detection + payment verification
│       │   └── human.ts     # redirect to hosted checkout
│       └── package.json
├── apps/
│   ├── api/                 # Fastify backend
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts       # OAuth, onboarding
│   │   │   │   ├── checkout.ts   # hosted checkout + Stripe session
│   │   │   │   ├── webhooks.ts   # Stripe + Base event handlers
│   │   │   │   └── dashboard.ts  # transaction data for UI
│   │   │   ├── db/
│   │   │   │   └── sqlite.ts     # SQLite client + migrations
│   │   │   └── payment/
│   │   │       ├── x402.ts       # verify x402 payment against Base
│   │   │       └── stripe.ts     # Stripe Connect helpers
│   │   └── package.json
│   └── dashboard/           # Next.js developer dashboard
│       ├── app/
│       └── package.json
├── contracts/               # Solidity smart contracts
│   ├── PaymentSplitter.sol  # Auto-splits platform fee + developer payout
│   ├── hardhat.config.ts
│   └── deploy/
├── docker-compose.yml
└── package.json             # workspace root (npm workspaces)
```

## Payment Flows

### AI Agent (x402)

```
Agent sends request (no payment)
  → Endpoint returns HTTP 402 + payment requirements
    (asset: USDC, network: Base, payTo: PaymentSplitter contract)
  → Agent signs USDC authorization via GatewayClient
  → Agent retries request with X-Payment header
  → Middleware verifies tx on Base RPC
  → PaymentSplitter contract auto-splits:
      0.5% → platform wallet
      99.5% → developer wallet
  → 200 OK, resource delivered
```

### Human User (Stripe)

```
Human sends request (no payment session)
  → Middleware detects browser (Accept: text/html)
  → Redirect to pay.universalpaywall.com/checkout?merchant=X&resource=Y
  → Platform creates Stripe Checkout Session
      (application_fee_amount = 0.5% of price)
  → User pays by card → Stripe handles 3DS, fraud, etc.
  → Stripe routes: 0.5% to platform, 99.5% to developer Stripe Connect account
  → Stripe redirects user back to original resource URL
  → Middleware verifies Stripe session → 200 OK
```

## Data Model (SQLite)

```sql
-- Developer accounts
CREATE TABLE developers (
  id            TEXT PRIMARY KEY,  -- UUID
  email         TEXT UNIQUE NOT NULL,
  stripe_account_id TEXT,          -- Stripe Connect account ID
  base_wallet   TEXT,              -- Base chain wallet address
  created_at    TEXT NOT NULL
);

-- API keys for middleware auth
CREATE TABLE api_keys (
  key_hash      TEXT PRIMARY KEY,  -- blake3(api_key), never store plaintext
  developer_id  TEXT NOT NULL REFERENCES developers(id),
  revoked_at    TEXT               -- NULL = active
);

-- Transaction log (populated from Stripe webhooks + Base events)
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id),
  payer_type    TEXT NOT NULL,     -- 'agent' | 'human'
  amount_usd    REAL NOT NULL,
  platform_fee  REAL NOT NULL,     -- 0.5% taken
  chain         TEXT,              -- 'base' | 'stripe'
  tx_hash       TEXT,              -- on-chain tx or Stripe payment_intent id
  created_at    TEXT NOT NULL
);
```

## External Integrations

| Service | Purpose |
|---|---|
| **Stripe Connect** | Fiat payment processing + automatic platform fee split |
| **Base RPC** (Alchemy/Infura) | Verify x402 USDC transactions on Base |
| **Circle @circle-fin/x402-batching** | x402 protocol client for agent payments |
| **Google/GitHub OAuth** | Developer authentication |

## Key Dependencies

- `@circle-fin/x402-batching` — x402 protocol (server + client)
- `viem` — Base chain interaction (read tx, verify transfers)
- `stripe` — Stripe Connect API
- `better-sqlite3` — SQLite driver (sync, fast)
- `@openzeppelin/contracts` — PaymentSplitter base contract
- `hardhat` — contract compilation + deployment
