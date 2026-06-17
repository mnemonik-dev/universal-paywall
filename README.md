# Universal Paywall

Open-core paywall for HTTP services. Charges AI agents through the x402 protocol on the Arc Network (Arc Testnet for MVP; chain-agnostic by design) and human users through Stripe Connect. Service owners receive payment from both audiences without writing settlement code.

## Project Structure

```
packages/middleware/   # @universal-paywall/middleware — npm package
apps/api/              # Fastify backend (onboarding, checkout, webhooks, dashboard API)
apps/dashboard/        # Next.js developer dashboard
contracts/             # Solidity PaymentSplitterFactory (Foundry)
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
cd contracts && forge test

# Deploy contracts (Arc Testnet staging) — maintainer-only flow, see below
cd contracts && forge script script/Deploy.s.sol:Deploy \
  --rpc-url $ARC_RPC_URL --broadcast --verify
```

## Getting paid by AI agents (x402 on Arc Testnet)

This section walks a new developer end-to-end from "fresh checkout" to "your endpoint returns HTTP 402 and gets paid by an x402-aware agent". The four steps are in the order you run them.

### 1. Claim test USDC from the faucet

x402 settles in USDC. Arc Testnet pays gas in USDC too, so you need a small balance before you can register.

1. Open [https://faucet.circle.com](https://faucet.circle.com) and select **Arc Testnet** in the network selector. _Screenshot: faucet showing Arc Testnet selected._
2. Paste your developer EOA address and claim. If Arc Testnet is not yet listed at Circle's faucet, fall back to [https://thirdweb.com/arc-testnet](https://thirdweb.com/arc-testnet); both are documented in `deployment.md`.
3. Confirm USDC arrived: paste your address into [https://testnet.arcscan.network](https://testnet.arcscan.network) (Arc Testnet block explorer) and check the USDC balance.

You only need enough USDC to cover the `register()` transaction (~13 micro-USDC at current gas rates) — a single faucet drip is more than enough.

### 2. Register your EOA on the factory

This deploys a per-developer USDC vault as an EIP-1167 minimal proxy. The vault address is deterministic from your EOA, so the middleware can compute the `payTo` recipient off-chain without an RPC round-trip.

```bash
export REGISTER_KEY=0x<your-developer-eoa-private-key>
npx tsx scripts/register.ts --network arc-testnet
```

Expected output on the first run:

```
Registered. Vault: 0x<your-vault-address>
Tx: 0x<tx-hash>
```

Expected output on a re-run (idempotent):

```
Already registered. Vault: 0x<your-vault-address>
```

The CLI exits non-zero with `register_failed: <reason>` on RPC error, revert, or gas estimate failure. It never echoes your `REGISTER_KEY` to stdout or stderr under any code path; the value is wrapped in an opaque key handle the instant it is read from the environment.

### 3. Install the middleware

```bash
npm install @universal-paywall/middleware
```

Minimal Node http example:

```ts
import { createServer } from 'node:http';
import { withPaywall } from '@universal-paywall/middleware';
import { OpaqueRelayerKey } from '@universal-paywall/middleware';

const relayerKey = new OpaqueRelayerKey(process.env.PAYWALL_RELAYER_KEY!);

const handler = withPaywall(
  (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ paid: true }));
  },
  {
    price: '0.01',
    developerEoa: '0x<your-developer-eoa>',
    network: 'arc-testnet',
    facilitator: { mode: 'inline', relayerKey },
    resource: 'https://api.example.com/paid',
    description: 'Premium endpoint',
    mimeType: 'application/json',
  },
);

createServer(handler).listen(3000, () => console.log('listening on :3000'));
```

The `PAYWALL_RELAYER_KEY` env var is the **relayer signer** — the wallet that pays gas for settlements on behalf of paying agents. It is distinct from the `REGISTER_KEY` you used above. The relayer must hold a small USDC balance on Arc Testnet to cover gas; the middleware emits a typed `relayer_low_balance` security event (with the current `balanceUsdc` payload) whenever the balance dips below 1 USDC, which is the recommended channel for operational alerting (see `deployment.md`).

### 4. Run the server and confirm 402

```bash
PAYWALL_RELAYER_KEY=0x<your-relayer-private-key> node server.js
# in another terminal:
curl -i http://localhost:3000/paid
```

A request without an `X-PAYMENT` header should return:

```
HTTP/1.1 402 Payment Required
content-type: application/json

{"x402Version":1,"error":"payment_required","accepts":[{
  "scheme":"exact","network":"eip155:5042002","maxAmountRequired":"10000",
  "payTo":"0x<your-vault-address>","asset":"0x3600000000000000000000000000000000000000",
  "maxTimeoutSeconds":60,
  "extra":{"assetTransferMethod":"eip3009","name":"USDC","version":"2"},
  ...
}]}
```

The body shape is validated by the x402 v1 schema (per the `user-spec.md` acceptance criteria). An x402-aware AI agent now has everything it needs: the EIP-3009 asset transfer method, the per-payment amount in micro-USDC, your vault address as the recipient, and the EIP-712 domain (`name: "USDC"`, `version: "2"`) used to recover signatures.

### Operational reading

For production-time concerns, see [`deployment.md`](.claude/skills/project-knowledge/references/deployment.md):

- relayer balance monitoring (the `relayer_low_balance` event)
- multisig ownership of the factory (Ownable2Step + Safe)
- fee schedule semantics and the 1000-bps cap (D10)
- treasury-DoS risk: `PLATFORM_TREASURY_ADDRESS` MUST be a plain EOA or audited multisig, never a contract with custom token-receive logic

## Maintainer: deploying the contracts to Arc Testnet

The end-to-end deploy is a two-step pipeline.

```bash
# 1. Foundry deploys the factory; the factory's constructor also deploys
#    the immutable PaymentVaultImpl.
cd contracts
export DEPLOYER_KEY=0x<deployer-private-key>
export PLATFORM_TREASURY_ADDRESS=0x<treasury-eoa-or-multisig>
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $ARC_RPC_URL --broadcast --verify

# 2. Patch packages/middleware/src/networks.ts with the new addresses.
cd ..
npx tsx contracts/scripts/post-deploy.ts
```

`forge script ... --verify` submits the factory source to arcscan automatically. The `--verify` step occasionally races the arcscan indexer or reports "already verified" — both are non-fatal and surfaced in stdout. If verification did not succeed, re-run:

```bash
cd contracts
forge verify-contract --chain-id 5042002 <factory_address> \
  src/PaymentSplitterFactory.sol:PaymentSplitterFactory \
  --constructor-args $(cast abi-encode "constructor(address,address,uint16)" \
    0x3600000000000000000000000000000000000000 \
    $PLATFORM_TREASURY_ADDRESS 50)
```

When you run this in CI, mask `$PLATFORM_TREASURY_ADDRESS` (and `$DEPLOYER_KEY`) in the job log output. GitHub Actions does this automatically for secrets registered as `secrets.*`; on other runners, redirect the `forge`/`cast` stdout through `sed` or use the runner's "mask" primitive — these addresses are public, but echoing them in log streams adds avoidable surface.

`contracts/scripts/post-deploy.ts` is idempotent — re-running against the same broadcast artifact produces no diff. On the canonical `arc-testnet` chain it refuses to overwrite already-populated addresses without `--force`; pass `--force` only when you intentionally redeploy.

## Canonical environment variables

| Variable                    | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `DEPLOYER_KEY`              | Deployer EOA private key for `forge script`              |
| `PLATFORM_TREASURY_ADDRESS` | Address that receives platform fees on `vault.withdraw()`|
| `ARC_RPC_URL`               | Arc Testnet JSON-RPC URL (default in `networks.ts`)      |
| `REGISTER_KEY`              | Developer EOA private key for `scripts/register.ts`      |
| `PAYWALL_RELAYER_KEY`       | Relayer EOA private key that pays gas for settlements    |

No legacy variants (`ARC_TESTNET_RPC_URL`, `ARC_TESTNET_PRIVATE_KEY`) are accepted anywhere in this repo.

## Project Knowledge

Architecture, patterns, deployment, and UX guidelines live in `.claude/skills/project-knowledge/references/`.

## Default Branch

`main` — production. Feature branches off `dev`. PRs go to `dev` first.
