---
feature: arc-mainnet-deploy
created: 2026-09-27
status: draft
---

# Arc Mainnet Deployment Spec

Deploy the Universal Paywall rail (`StakeVaultFactory` + `StakeVault`) to Arc mainnet
and wire all downstream packages to use it.

Arc is Circle's native USDC Layer-1. It went live **2026-09-16**. USDC is the gas
token. Finality is sub-second. Validators include BlackRock, Visa, Mastercard, and
Standard Chartered.

---

## 1. Arc Mainnet Chain Parameters

| Parameter          | Value                                         |
|--------------------|-----------------------------------------------|
| Network name       | Arc                                           |
| Chain ID           | **5042** (hex `0x13b2`)                       |
| CAIP-2             | `eip155:5042`                                 |
| RPC URL            | `https://rpc.mainnet.arc.io`                  |
| Block explorer     | `https://explorer.arc.io`                     |
| Gas token          | USDC (EIP-1559, min base fee 20 gwei ≈ $0.01) |
| Finality           | Deterministic, < 1 s                          |

Testnet (reference):
- Chain ID: 5042002, CAIP-2 `eip155:5042002`
- RPC: `https://rpc.testnet.arc.io`

---

## 2. Circle-Deployed Contract Addresses on Arc

All addresses sourced from [docs.arc.io/arc/references/contract-addresses](https://docs.arc.io/arc/references/contract-addresses).

### Core stablecoins

| Token  | Mainnet address                              | Notes                                      |
|--------|----------------------------------------------|--------------------------------------------|
| USDC   | `0x3600000000000000000000000000000000000000` | System contract; same address as testnet   |
| EURC   | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` |                                            |
| USYC   | `0x8a5D989Bbb96929F689B0200f435f53dA42bF490` | yield-bearing stablecoin                   |

USDC uses **6 decimals** in the ERC-20 view (native gas layer is 18-decimal; the
ERC-20 interface transparently converts).

### Wrapped assets

| Token   | Mainnet address                              |
|---------|----------------------------------------------|
| cirBTC  | `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0` |
| WETH    | `0x128cC466B61f542da60c70e3aA11c10e19B84EDB` |

### CCTP v2 (Domain 26)

| Contract               | Mainnet address                              |
|------------------------|----------------------------------------------|
| TokenMessenger         | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| MessageTransmitter     | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| CrossChainTokenService | `0x431871229103b780868f8C6BB820cd16ECf942BC` |

CCTP domain for Arc mainnet = **26**.

### Gateway (Circle programmable wallets)

| Contract      | Mainnet address                              |
|---------------|----------------------------------------------|
| GatewayWallet | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| GatewayMinter | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |

### Standard EVM infrastructure (same on mainnet and testnet)

| Contract         | Address                                      |
|------------------|----------------------------------------------|
| Permit2          | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3       | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| CREATE2 Factory  | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |

---

## 3. Our Contracts to Deploy

Two contracts must be deployed; the factory deploys the impl internally in its
constructor (no separate deploy call needed).

| Contract           | Deployer           | Constructor arg               | Post-deploy address |
|--------------------|--------------------|-------------------------------|---------------------|
| `StakeVaultFactory`| `DEPLOYER_KEY` EOA | `usdc = 0x3600...0000`        | TBD after deploy    |
| `StakeVault` (impl)| deployed by factory| _(none — internal CREATE)_    | TBD after deploy    |

Testnet values for reference:
- `factoryAddress`: `0x028442a366fd124a9e953c90dae58afb8b8db9d8`
- `vaultImplAddress`: `0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45`

### Deploy command

```bash
cd contracts

# Verify Arc mainnet USDC domain on-chain first (see §4)
ARC_RPC_URL=https://rpc.mainnet.arc.io \
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
DEPLOYER_KEY=$DEPLOYER_KEY \
forge script script/DeployStakeRail.s.sol:DeployStakeRail \
  --rpc-url https://rpc.mainnet.arc.io \
  --broadcast \
  --verify \
  --verifier-url https://explorer.arc.io/api \
  --chain-id 5042
```

Expected console output:
```
STAKE_VAULT_FACTORY  <factory-address>
STAKE_VAULT_IMPL     <impl-address>
USDC                 0x3600000000000000000000000000000000000000
```

---

## 4. USDC EIP-712 Domain Verification (pre-deploy gate)

The testnet domain: `name = "USDC"`, `version = "2"` (Arc-specific, verified on-chain
in Task 3 — `contracts/scripts/arc-testnet-usdc-domain.json`).

Before wiring mainnet in `networks.ts`, confirm the mainnet domain matches:

```bash
# Run the existing domain-fetch script against mainnet RPC
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
ARC_RPC_URL=https://rpc.mainnet.arc.io \
npx tsx packages/middleware/scripts/generate-arc-testnet-usdc-domain.ts \
  --output contracts/scripts/arc-mainnet-usdc-domain.json
```

Expected: `name = "USDC"`, `version = "2"`. Commit the artefact.

---

## 5. Code Changes After Deploy

### `packages/middleware/src/networks.ts`

Fill `arcMainnet` with real values (currently all `0x0` placeholders, `enabled: false`):

```typescript
const arcMainnet: NetworkConfig = {
  id: 'eip155:5042',
  alias: 'arc-mainnet',
  chainId: 5042,
  rpcUrl: process.env['ARC_MAINNET_RPC_URL'] ?? 'https://rpc.mainnet.arc.io',
  usdcAddress: '0x3600000000000000000000000000000000000000',
  usdcEip712Name: arcMainnetUsdcDomain.name,   // from generated artefact
  usdcEip712Version: arcMainnetUsdcDomain.version,
  factoryAddress: '<DEPLOYED_FACTORY_ADDRESS>' /* deploy-script:factoryAddress */,
  vaultImplAddress: '<DEPLOYED_IMPL_ADDRESS>'  /* deploy-script:vaultImplAddress */,
  enabled: true,
};

export const NETWORKS = {
  'arc-testnet':   arcTestnet,
  'eip155:5042002': arcTestnet,
  'arc-mainnet':   arcMainnet,
  'eip155:5042':   arcMainnet,   // was 'eip155:0'
} as const satisfies Record<string, NetworkConfig>;
```

Also add the import:
```typescript
import { arcMainnetUsdcDomain } from './generated/arc-mainnet-usdc-domain.js';
```

### `packages/middleware/scripts/generate-arc-testnet-usdc-domain.ts`

Clone (or generalise) the script to accept RPC URL + output path as args so it works
for both testnet and mainnet. Add `prebuild` hook to regenerate mainnet artefact too.

### `contracts/script/DeployStakeRail.s.sol`

Update inline comment to note both testnet and mainnet invocations.

---

## 6. Gas / Economics on Arc Mainnet

| Metric                          | Value                                      |
|---------------------------------|--------------------------------------------|
| Minimum base fee                | 20 gwei                                    |
| Typical tx cost                 | ~$0.01                                     |
| `StakeVaultFactory` deploy gas  | ~600 000 gas → ~$0.006 at min base fee     |
| `settle()` batch gas            | ~60 000 gas/call → ~$0.0006 per batch      |

Payers stake USDC in their vault; no protocol fee on Arc mainnet (feeless rail). The
facilitator's off-chain fee (if any) is separate.

---

## 7. Open Items Before Mainnet Deploy

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Provision mainnet deployer EOA + fund with USDC for gas | — | TODO |
| 2 | Run domain-fetch script against mainnet RPC; commit `arc-mainnet-usdc-domain.json` | — | TODO |
| 3 | Deploy `StakeVaultFactory` on Arc mainnet; record addresses | — | TODO |
| 4 | Fill `arcMainnet` in `networks.ts`; flip `enabled: true` | — | TODO |
| 5 | Add `arc-mainnet` to `NETWORKS` export with correct `eip155:5042` key | — | TODO |
| 6 | Verify factory on-chain via block explorer (`https://explorer.arc.io`) | — | TODO |
| 7 | Run existing e2e tests against mainnet fork (`--fork-url https://rpc.mainnet.arc.io`) | — | TODO |
| 8 | Update facilitator `.env.example`: `ARC_MAINNET_RPC_URL`, `ARC_MAINNET_NETWORK=arc-mainnet` | — | TODO |

---

## 8. What's NOT in Scope Here

- **Reputation system** — not yet designed; separate spec needed
- **EURC / USYC payment support** — USDC-only in Phase 1
- **CCTP cross-chain bridging** — facilitator can use CCTP for multi-chain settlement later
- **On-chain policy-cert verifier** — tracked in `work/snark-policy-certificates/`

---

## Sources

- [Arc Contract Addresses — docs.arc.io](https://docs.arc.io/arc/references/contract-addresses)
- [Arc Mainnet Chain ID & RPC](https://trustswap.com/arc/mainnet-live)
- [Circle's Arc Blockchain live — CryptoTimes 2026-09-16](https://www.cryptotimes.io/2026/09/16/circles-usdc-native-layer-1-blockchain-arc-goes-live-on-mainnet/)
