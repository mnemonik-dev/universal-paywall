/**
 * `NETWORKS` registry — chain configuration table.
 *
 * Each row is a `NetworkConfig`. Keys are present in BOTH forms:
 *   - alias (e.g. `'arc-testnet'`)
 *   - canonical CAIP-2 (e.g. `'eip155:5042002'`)
 * Both keys point at the SAME object reference (per D1), so a lookup by either
 * form returns the same row identity.
 *
 * USDC EIP-712 domain (`usdcEip712Name` / `usdcEip712Version`) is sourced
 * from on-chain-verified JSON artefacts under `contracts/scripts/`. The values
 * are mirrored into the bundle at build time via the `prebuild` hook, emitting
 * `src/generated/arc-{testnet,mainnet}-usdc-domain.ts`. This way the published
 * bundle does not depend on a monorepo-relative path at runtime.
 *
 * `factoryAddress` / `vaultImplAddress` ship as `0x0…0` placeholders with
 * `deploy-script:*` sentinel comments (per systemic-fix §13); the deploy script
 * does a sed-anchored replacement on these lines after a successful broadcast.
 *
 * Arc mainnet launched 2026-09-16 (chain ID 5042, CAIP-2 eip155:5042).
 * Factory + impl addresses pending deployment — see work/arc-mainnet-deploy/tech-spec.md.
 */

import type { NetworkConfig } from './types.js';
import { arcTestnetUsdcDomain } from './generated/arc-testnet-usdc-domain.js';
import { arcMainnetUsdcDomain } from './generated/arc-mainnet-usdc-domain.js';

if (Array.isArray(arcTestnetUsdcDomain.notes) && arcTestnetUsdcDomain.notes.length > 0) {
  // Surface T3 notes at module load so operators see them in their boot logs.
  // Using console.warn (not console.log) so test runners capturing stdout don't
  // accidentally swallow them. Behind a guard so test suites can opt out.
  if (process.env['UP_SUPPRESS_T3_NOTES'] !== '1') {
    for (const note of arcTestnetUsdcDomain.notes) {
      // eslint-disable-next-line no-console
      console.warn(`[universal-paywall] arc-testnet USDC note: ${note}`);
    }
  }
}

const arcTestnet: NetworkConfig = {
  id: 'eip155:5042002',
  alias: 'arc-testnet',
  chainId: 5042002,
  rpcUrl: process.env['ARC_RPC_URL'] ?? 'https://rpc.testnet.arc.network',
  usdcAddress: '0x3600000000000000000000000000000000000000',
  usdcEip712Name: arcTestnetUsdcDomain.name,
  usdcEip712Version: arcTestnetUsdcDomain.version,
  factoryAddress: '0x028442a366fd124a9e953c90dae58afb8b8db9d8' /* deploy-script:factoryAddress */,
  vaultImplAddress:
    '0x1c65f3ee224dfe4bd7b3ad873956ab238b0dfa45' /* deploy-script:vaultImplAddress */,
  enabled: true,
};

// Arc mainnet launched 2026-09-16. Chain parameters confirmed from docs.arc.io.
// factory/vaultImpl addresses pending deployment — left as 0x0 sentinels until
// `forge script DeployStakeRail` broadcast is run against mainnet (see tech-spec).
const arcMainnet: NetworkConfig = {
  id: 'eip155:5042',
  alias: 'arc-mainnet',
  chainId: 5042,
  rpcUrl: process.env['ARC_MAINNET_RPC_URL'] ?? 'https://rpc.mainnet.arc.io',
  usdcAddress: '0x3600000000000000000000000000000000000000',
  usdcEip712Name: arcMainnetUsdcDomain.name,
  usdcEip712Version: arcMainnetUsdcDomain.version,
  factoryAddress: '0x0000000000000000000000000000000000000000' /* deploy-script:factoryAddress */,
  vaultImplAddress: '0x0000000000000000000000000000000000000000' /* deploy-script:vaultImplAddress */,
  enabled: false, // flip to true after StakeVaultFactory deployed + addresses filled
};

export const NETWORKS = {
  'arc-testnet': arcTestnet,
  'eip155:5042002': arcTestnet,
  'arc-mainnet': arcMainnet,
  'eip155:5042': arcMainnet,
} as const satisfies Record<string, NetworkConfig>;

/**
 * Maps an alias or canonical CAIP-2 id to the canonical CAIP-2 form.
 *
 * Used by `verify.ts` so the "payload.network normalize equals opts.network
 * normalize" check (tech-spec Solution step 7c) works uniformly regardless of
 * which form the caller passed.
 */
export function normalizeNetworkId(input: string): string | undefined {
  const row = (NETWORKS as Record<string, NetworkConfig | undefined>)[input];
  return row?.id;
}
