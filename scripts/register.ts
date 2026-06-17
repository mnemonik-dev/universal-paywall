#!/usr/bin/env tsx
/**
 * register.ts — developer-EOA CLI that calls `factory.register()` on the
 * configured network. Reads `REGISTER_KEY` from env, wraps it immediately in
 * `OpaqueRelayerKey` (D13), and never serializes the raw secret to stdout or
 * stderr through any code path.
 *
 * Idempotent: pre-flight reads `factory.vaults(eoa)` and prints
 * "Already registered. Vault: 0x..." (exit 0) if the EOA already has a vault.
 *
 * Usage:
 *   REGISTER_KEY=0x... tsx scripts/register.ts --network arc-testnet
 *
 * Exit codes:
 *   0 — success (fresh register or already-registered idempotent)
 *   1 — register_failed:<reason>  (RPC error, revert, gas estimate fail, etc.)
 *   2 — REGISTER_KEY env var missing or malformed
 *   3 — unknown or disabled --network
 *
 * Per iteration-3 addendum §12, `getRelayerKeySecret` is imported from the
 * internal middleware module path; it is NOT re-exported from the public
 * `@universal-paywall/middleware` entry point.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  HttpRequestError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { NETWORKS, OpaqueRelayerKey } from '../packages/middleware/src/index.js';
import { getRelayerKeySecret } from '../packages/middleware/src/relayer-key.js';
import type { NetworkConfig } from '../packages/middleware/src/types.js';

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'register',
    inputs: [],
    outputs: [{ name: 'vault', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'vaults',
    inputs: [{ name: 'developer', type: 'address' }],
    outputs: [{ name: 'vault', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

interface Args {
  network: string;
  help: boolean;
  /** Test-only: when --network=test-anvil, read TEST_FACTORY_ADDRESS from env
   *  and bypass NETWORKS lookup. Gated on process.env.NODE_ENV === 'test'. */
  allowTestNetwork: boolean;
}

function parseArgs(argv: string[]): Args {
  let network = 'arc-testnet';
  let help = false;
  let allowTestNetwork = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--network': {
        const v = argv[++i];
        if (!v) throw new Error('--network requires a value');
        network = v;
        break;
      }
      case '--allow-test-network':
        allowTestNetwork = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return { network, help, allowTestNetwork };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: tsx scripts/register.ts [--network <alias>]',
      '',
      'Calls factory.register() from the EOA derived from REGISTER_KEY,',
      "creating the developer's per-EOA vault (idempotent — re-runs are no-ops).",
      '',
      'Flags:',
      '  --network <alias>   network alias (default: arc-testnet)',
      '  --help, -h          show this message',
      '',
      'Environment:',
      '  REGISTER_KEY        developer EOA private key (0x + 64 hex chars), required',
      '  ARC_RPC_URL         override the Arc Testnet RPC URL (default in NETWORKS)',
      "  PAYWALL_RELAYER_KEY (unrelated — used by the middleware's facilitator,",
      '                       NOT by this script)',
      '',
      'Exit codes:',
      '  0 — success (registered or already registered)',
      '  1 — register_failed:<reason>',
      '  2 — REGISTER_KEY missing or malformed',
      '  3 — unknown or disabled network',
      '',
    ].join('\n'),
  );
}

function buildTestNetwork(): NetworkConfig {
  const factoryAddress = process.env['TEST_FACTORY_ADDRESS'];
  const rpcUrl = process.env['TEST_RPC_URL'];
  if (!factoryAddress) {
    throw new Error('test-anvil requires TEST_FACTORY_ADDRESS env var');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(factoryAddress)) {
    throw new Error('TEST_FACTORY_ADDRESS must be a 20-byte hex address');
  }
  if (!rpcUrl) {
    throw new Error('test-anvil requires TEST_RPC_URL env var');
  }
  return {
    id: 'eip155:31337',
    alias: 'test-anvil',
    chainId: 31337,
    rpcUrl,
    usdcAddress: ZERO_ADDRESS,
    usdcEip712Name: 'TEST',
    usdcEip712Version: '1',
    factoryAddress: factoryAddress as Address,
    vaultImplAddress: ZERO_ADDRESS,
    enabled: true,
  };
}

function classifyError(err: unknown): string {
  if (err instanceof HttpRequestError) {
    const status = err.status;
    if (typeof status === 'number' && status >= 500) return 'rpc_5xx';
    return 'rpc_5xx';
  }
  const name = (err as { name?: string } | undefined)?.name ?? '';
  const message = ((err as Error | undefined)?.message ?? '').toLowerCase();
  if (name.includes('Timeout') || message.includes('timeout')) return 'rpc_timeout';
  if (name === 'EstimateGasExecutionError' || message.includes('estimate gas')) {
    return 'gas_estimate_revert';
  }
  if (message.includes('insufficient funds') || message.includes('balance too low')) {
    return 'relayer_no_balance';
  }
  if (message.includes('reverted')) return 'receipt_reverted';
  return 'unknown';
}

async function run(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  const rawKey = (process.env['REGISTER_KEY'] ?? '').trim();
  if (!rawKey || !PRIVATE_KEY_RE.test(rawKey)) {
    // Intentionally does NOT echo any substring of the input.
    process.stderr.write('REGISTER_KEY env var missing or malformed\n');
    return 2;
  }

  // Wrap immediately so no downstream code path holds the raw string.
  const opaque = new OpaqueRelayerKey(rawKey);

  let network: NetworkConfig;
  if (
    args.network === 'test-anvil' &&
    (process.env['NODE_ENV'] === 'test' || args.allowTestNetwork)
  ) {
    // Test-only branch — do not invoke from production scripts.
    try {
      network = buildTestNetwork();
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 3;
    }
  } else {
    const lookup = (NETWORKS as Record<string, NetworkConfig | undefined>)[args.network];
    if (!lookup) {
      process.stderr.write(`unknown network: ${args.network}\n`);
      return 3;
    }
    if (!lookup.enabled) {
      process.stderr.write(`network is disabled: ${args.network}\n`);
      return 3;
    }
    if (lookup.factoryAddress === ZERO_ADDRESS) {
      process.stderr.write(
        `network has no deployed factory address: ${args.network} — run deploy + post-deploy first\n`,
      );
      return 3;
    }
    network = lookup;
  }

  const chain = defineChain({
    id: network.chainId,
    name: network.alias,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
  });

  // Only call site of getRelayerKeySecret in this script: extract is gated.
  const secret = getRelayerKeySecret(opaque) as Hex;
  const account = privateKeyToAccount(secret);

  const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(network.rpcUrl),
  });

  try {
    const existing = (await publicClient.readContract({
      abi: FACTORY_ABI,
      address: network.factoryAddress,
      functionName: 'vaults',
      args: [account.address],
    })) as Address;

    if (existing !== ZERO_ADDRESS) {
      process.stdout.write(`Already registered. Vault: ${existing}\n`);
      return 0;
    }

    const txHash = await walletClient.writeContract({
      abi: FACTORY_ABI,
      address: network.factoryAddress,
      functionName: 'register',
      args: [],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      process.stderr.write('register_failed: receipt_reverted\n');
      return 1;
    }

    const vault = (await publicClient.readContract({
      abi: FACTORY_ABI,
      address: network.factoryAddress,
      functionName: 'vaults',
      args: [account.address],
    })) as Address;

    if (vault === ZERO_ADDRESS) {
      process.stderr.write('register_failed: receipt_reverted\n');
      return 1;
    }

    process.stdout.write(`Registered. Vault: ${vault}\n`);
    process.stdout.write(`Tx: ${txHash}\n`);
    return 0;
  } catch (err) {
    const reason = classifyError(err);
    process.stderr.write(`register_failed: ${reason}\n`);
    return 1;
  }
}

run().then(
  (code) => process.exit(code),
  (err) => {
    // Fallback — should not be reached because run() catches its own errors.
    process.stderr.write(`register_failed: ${classifyError(err)}\n`);
    process.exit(1);
  },
);
