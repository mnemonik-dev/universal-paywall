/**
 * `NETWORKS` registry — chain configuration table.
 *
 * Each row is a `NetworkConfig`. Keys are present in BOTH forms:
 *   - alias (e.g. `'arc-testnet'`)
 *   - canonical CAIP-2 (e.g. `'eip155:5042002'`)
 * Both keys point at the SAME object reference (per D1), so a lookup by either
 * form returns the same row identity.
 *
 * `arc-mainnet` is a deliberate placeholder (`chainId: 0`, `id: 'eip155:0'`,
 * `enabled: false`) per systemic-fix §8 — NOT `eip155:42161`, which would
 * alias Arbitrum One's real CAIP-2 and produce false-positive matches.
 *
 * USDC EIP-712 domain (`usdcEip712Name` / `usdcEip712Version`) is populated
 * from Task 3's on-chain-verified JSON artefact at
 * `contracts/scripts/arc-testnet-usdc-domain.json`. If that file is missing
 * at module load — this module throws a BLOCKER error rather than ship with
 * stub values. Reason: silent stubs would mean `verify.ts` produces wrong
 * EIP-712 domain hashes and every signature recovery would fail on-chain.
 *
 * `factoryAddress` / `vaultImplAddress` ship as `0x0…0` placeholders with
 * `deploy-script:*` sentinel comments (per systemic-fix §13); Task 11's
 * deploy script does a sed-anchored replacement on these lines.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkConfig } from './types.js';

interface ArcTestnetUsdcDomain {
  name: string;
  version: string;
  decimals: number;
  supportsEip3009: boolean;
  notes?: string[];
}

function loadArcTestnetUsdcDomain(): ArcTestnetUsdcDomain {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/middleware/src → ../../../contracts/scripts (or dist → ../../../contracts/scripts)
  const candidates = [
    resolve(here, '../../../contracts/scripts/arc-testnet-usdc-domain.json'),
    resolve(here, '../../../../contracts/scripts/arc-testnet-usdc-domain.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as ArcTestnetUsdcDomain;
      if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
        throw new Error(
          `NETWORKS bootstrap failed: T3 USDC domain artefact at ${path} is missing required fields (name, version)`,
        );
      }
      return parsed;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') continue;
      throw err;
    }
  }
  throw new Error(
    'NETWORKS bootstrap failed: T3 USDC domain artefact missing at contracts/scripts/arc-testnet-usdc-domain.json — run T3 first',
  );
}

const arcTestnetUsdcDomain = loadArcTestnetUsdcDomain();

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

// TODO(arc-mainnet-release): set canonical CAIP-2 + chainId + addresses when Circle ships.
const arcMainnet: NetworkConfig = {
  id: 'eip155:0',
  alias: 'arc-mainnet',
  chainId: 0,
  rpcUrl: '',
  usdcAddress: '0x0000000000000000000000000000000000000000',
  usdcEip712Name: '',
  usdcEip712Version: '',
  factoryAddress: '0x0000000000000000000000000000000000000000',
  vaultImplAddress: '0x0000000000000000000000000000000000000000',
  enabled: false,
};

export const NETWORKS = {
  'arc-testnet': arcTestnet,
  'eip155:5042002': arcTestnet,
  'arc-mainnet': arcMainnet,
  'eip155:0': arcMainnet,
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
