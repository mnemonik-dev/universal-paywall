# Universal Paywall — Architecture

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Middleware (npm)** | TypeScript | Matches JS ecosystem where most API servers live; compatible with arc-nanopayments patterns |
| **Backend API** | Node.js + Fastify | TypeScript-native, fast, minimal boilerplate for REST + webhook handlers |
| **Frontend dashboard** | Next.js | SSR + API routes in one project; fast to build admin UI |
| **Smart contracts** | Solidity 0.8.20+ + Hardhat | `PaymentSplitterFactory` + `PaymentVaultImpl` (EIP-1167 minimal proxy via `Clones.cloneDeterministic`). OpenZeppelin 5.x Ownable2Step/Pausable/ReentrancyGuard/SafeERC20. Vault is a passive USDC receiver; fee split happens at `withdraw()`. |
| **Database** | SQLite | Zero config, single file, sufficient for MVP on one VPS; same pattern as mnemonik monorepo |
| **x402 protocol** | Standard x402 v1, self-hosted facilitator inline in middleware | Open-source spec; we are a server + facilitator; clients (CDP SDK, Circle SDK, custom) interoperate via wire format. No pinned client SDK. |
| **Fiat payments** | Stripe Connect | Platform model: auto-split via `application_fee_amount`, Stripe handles KYC/compliance |
| **Blockchain** | EVM-compatible (chain-agnostic) | Architecture supports any EVM chain; Arc Network is first supported chain (low fees, Circle USDC native). Base, Ethereum mainnet — post-MVP. |
| **Hosting** | Hetzner VPS | Cost-effective, full control, Docker-based |
| **CI/CD** | GitHub Actions | |
| **Containers** | Docker + Docker Compose | |

## Project Structure

```
universal-paywall/
├── packages/
│   └── middleware/                  # npm package: @universal-paywall/middleware
│       ├── src/
│       │   ├── index.ts             # public exports
│       │   ├── core.ts              # framework-agnostic paywall(req, opts)
│       │   ├── adapters/
│       │   │   ├── node-http.ts     # withPaywall(handler) for Node http
│       │   │   └── fastify.ts       # fastifyPaywall(handler) for Fastify
│       │   ├── x402.ts              # 402 body builder + X-PAYMENT/X-PAYMENT-RESPONSE codec
│       │   ├── verify.ts            # off-chain EIP-712 ecrecover via viem
│       │   ├── settle.ts            # on-chain settle via splitter.payWithAuthorization
│       │   ├── replay-store.ts      # in-memory consumed-nonce set with TTL
│       │   ├── networks.ts          # NETWORKS map (chainId, rpcUrl, usdcAddress, splitterAddress)
│       │   ├── errors.ts            # structured x402 error response builders
│       │   └── types.ts             # PaymentRequirements, PaymentPayload exports
│       ├── test/
│       └── package.json
├── apps/
│   ├── api/                         # Fastify backend
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts          # OAuth, onboarding
│   │   │   │   ├── checkout.ts      # hosted checkout + Stripe session
│   │   │   │   ├── webhooks.ts      # Stripe + on-chain event handlers
│   │   │   │   └── dashboard.ts     # transaction data for UI
│   │   │   ├── db/
│   │   │   │   └── sqlite.ts        # SQLite client + migrations
│   │   │   └── payment/
│   │   │       ├── x402.ts          # x402 facilitator helpers shared with middleware
│   │   │       └── stripe.ts        # Stripe Connect helpers
│   │   └── package.json
│   └── dashboard/                   # Next.js developer dashboard
│       ├── app/
│       └── package.json
├── contracts/                       # Solidity smart contracts
│   ├── contracts/
│   │   ├── PaymentSplitterFactory.sol   # Ownable2Step, Pausable; deploys per-developer vaults via Clones
│   │   ├── PaymentVaultImpl.sol         # Initializable, ReentrancyGuard; passive USDC receiver, splits on withdraw
│   │   ├── interfaces/
│   │   │   └── IERC3009.sol             # minimal interface for off-chain ABI use only
│   │   └── mocks/
│   │       └── MockUsdcEip3009.sol      # test mock with EIP-3009 implementation
│   ├── test/
│   │   ├── PaymentSplitterFactory.test.ts
│   │   ├── PaymentVaultImpl.test.ts
│   │   └── integration/forked-e2e.test.ts  # Hardhat-fork integration test, runs in CI
│   ├── deploy/
│   │   └── 01_deploy_factory.ts
│   ├── scripts/
│   │   └── verify-usdc-eip3009.ts       # Wave 1 spike against Arc Testnet
│   ├── hardhat.config.ts
│   └── package.json
├── scripts/
│   └── register.ts                  # CLI: developer calls factory.register() from their EOA
├── docker-compose.yml
└── package.json                     # workspace root (npm workspaces)
```

## Payment Flows

### AI Agent (x402)

Standard x402 protocol with EIP-3009 `transferWithAuthorization`. Middleware acts as a self-hosted x402 facilitator (verifies signature off-chain, settles on-chain, pays gas from a relayer wallet). Per-developer vault model: each developer pre-registers and gets a deterministic vault address; `payTo` in the 402 response is that vault address.

```
Agent sends request (no payment)
  → Endpoint returns HTTP 402 with JSON body { x402Version, accepts: [PaymentRequirements] }
    (scheme: "exact", network: "eip155:5042002" (alias "arc-testnet"),
     asset: USDC system address, payTo: developer's vault address
       (= factory.computeVaultAddress(developerEoa)),
     maxAmountRequired, resource, description, mimeType,
     extra: { assetTransferMethod: "eip3009", name: <USDC name>, version: "2" })
  → Agent signs EIP-3009 authorization off-chain (no gas, no broadcast):
      { from: agent, to: developerVault, value, validAfter, validBefore, nonce }
  → Agent retries request with X-PAYMENT: base64(JSON({x402Version, scheme, network, payload: {signature, authorization}}))
  → Middleware verifies signature off-chain (EIP-712 ecrecover with domain bound to chainId+verifyingContract)
  → Middleware checks middleware-side NonceStore (synchronous has+insert)
  → Middleware (as facilitator) calls USDC.transferWithAuthorization(from, to=vault, value, ...)
    on Arc Testnet, paying gas in USDC (Arc gas token is USDC)
  → USDC transfers from agent → developer's vault
  → 200 OK, X-PAYMENT-RESPONSE: base64({success, transaction, network, payer})

Later, async:
  → Developer calls vault.withdraw() (msg.sender-gated, nonReentrant)
  → Vault reads usdc.balanceOf(this) as gross,
    sends gross * (10000 - feeBps) / 10000 → developer,
    sends gross * feeBps / 10000 → factory.platformTreasury()
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
  evm_wallet    TEXT,              -- EVM wallet address (Arc / Base / ... — chain-agnostic)
  created_at    TEXT NOT NULL
);

-- API keys for middleware auth
CREATE TABLE api_keys (
  key_hash      TEXT PRIMARY KEY,  -- blake3(api_key), never store plaintext
  developer_id  TEXT NOT NULL REFERENCES developers(id),
  revoked_at    TEXT               -- NULL = active
);

-- Transaction log (populated from Stripe webhooks + on-chain events)
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id),
  payer_type    TEXT NOT NULL,     -- 'agent' | 'human'
  amount_usd    REAL NOT NULL,
  platform_fee  REAL NOT NULL,     -- 0.5% taken
  chain         TEXT,              -- 'arc-testnet' | 'arc-mainnet' | 'stripe' | ...
  tx_hash       TEXT,              -- on-chain tx or Stripe payment_intent id
  created_at    TEXT NOT NULL
);
```

## External Integrations

| Service | Purpose |
|---|---|
| **Stripe Connect** | Fiat payment processing + automatic platform fee split |
| **Arc RPC** (Arc Network Testnet) | Submit `transferWithAuthorization` settle transactions and read receipts; viem PublicClient + WalletClient (relayer signer), swappable per network config |
| **Standard x402 protocol** | Self-hosted facilitator in middleware. Compatible with any x402 v1 client (CDP SDK, Circle SDK, custom). Custom agent SDK not bundled with this repo. |
| **Google/GitHub OAuth** | Developer authentication |

## Key Dependencies

- `viem` — EVM chain interaction (RPC, EIP-712 typed-data ecrecover, contract calls, relayer signing). Chain-agnostic.
- `stripe` — Stripe Connect API
- `better-sqlite3` — SQLite driver (sync, fast)
- `@openzeppelin/contracts` 5.x — `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `Initializable`, `Clones`, `SafeERC20`, `IERC20`
- `hardhat`, `@nomicfoundation/hardhat-toolbox`, `@nomicfoundation/hardhat-verify` — contract compilation, testing, deployment, explorer verification
- `ajv` — JSON Schema validation of 402 body shape against vendored x402 v1 schema (test-time only)
- No prebuilt x402 client SDK pinned — we are protocol-compatible, clients use their own (CDP `x402` package, Circle SDK, or hand-rolled)
