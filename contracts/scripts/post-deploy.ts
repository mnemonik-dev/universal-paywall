#!/usr/bin/env tsx
/**
 * Post-deploy patcher for `packages/middleware/src/networks.ts`.
 *
 * Reads the forge broadcast artifact at
 *   contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json
 * extracts the deployed `PaymentSplitterFactory` address (top-level deploy tx
 * `contractAddress`) and the inner `PaymentVaultImpl` address (the CREATE
 * surfaced inside the factory constructor → `additionalContracts[0].address`),
 * and performs a sed-style sentinel-anchored substitution on `networks.ts`.
 *
 * Sentinels are OWNED BY T6 (per systemic-fix §13). This script only does the
 * substitution against them; if they are missing it fails loudly rather than
 * silently leaving zero-address placeholders.
 *
 * Idempotency: re-running against the same broadcast artifact produces the
 * same output bytes (the sentinel regex matches whether the literal is the
 * zero address OR the previously-substituted address).
 *
 * Live-network safety: on the canonical `arc-testnet` (chain 5042002) path,
 * if both sentinel-anchored address literals in `networks.ts` are already
 * non-zero, the script refuses to overwrite without `--force` (exit code 4).
 * Local-anvil runs (chain 31337) skip this guard so smoke iterations are
 * convenient.
 *
 * CLI flags:
 *   --chain-id <id>         default 5042002
 *   --broadcast-dir <path>  default contracts/broadcast/Deploy.s.sol/<chain-id>
 *   --networks-file <path>  default ../packages/middleware/src/networks.ts
 *   --network-alias <alias> default arc-testnet (documented, currently
 *                           informational — the sentinel substitution is
 *                           global in networks.ts since only the arc-testnet
 *                           row carries sentinels)
 *   --force                 bypass the already-populated safety on arc-testnet
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONTRACTS_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(CONTRACTS_DIR, '..');

interface Args {
  chainId: number;
  broadcastDir: string;
  networksFile: string;
  networkAlias: string;
  force: boolean;
}

interface AdditionalContract {
  transactionType?: string;
  address?: string;
}

interface ForgeTransaction {
  transactionType?: string;
  contractName?: string;
  contractAddress?: string;
  additionalContracts?: AdditionalContract[];
}

interface ForgeBroadcast {
  transactions?: ForgeTransaction[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Accepts both 'addr' (T6's actual format) and "addr" so the substitution is
// resilient to a future prettier change of quote style. The substitution
// preserves whatever quote style was found.
const FACTORY_SENTINEL_RE =
  /(['"])0x[0-9a-fA-F]{40}(['"])(\s*)\/\* deploy-script:factoryAddress \*\//;
const VAULT_IMPL_SENTINEL_RE =
  /(['"])0x[0-9a-fA-F]{40}(['"])(\s*)\/\* deploy-script:vaultImplAddress \*\//;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function parseArgs(argv: string[]): Args {
  let chainId = 5042002;
  let broadcastDir = '';
  let networksFile = resolve(REPO_ROOT, 'packages/middleware/src/networks.ts');
  let networkAlias = 'arc-testnet';
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--chain-id': {
        const v = argv[++i];
        if (!v) throw new Error('--chain-id requires a value');
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--chain-id must be a positive integer, got: ${v}`);
        }
        chainId = n;
        break;
      }
      case '--broadcast-dir': {
        const v = argv[++i];
        if (!v) throw new Error('--broadcast-dir requires a value');
        broadcastDir = v;
        break;
      }
      case '--networks-file': {
        const v = argv[++i];
        if (!v) throw new Error('--networks-file requires a value');
        networksFile = v;
        break;
      }
      case '--network-alias': {
        const v = argv[++i];
        if (!v) throw new Error('--network-alias requires a value');
        networkAlias = v;
        break;
      }
      case '--force':
        force = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }

  if (!broadcastDir) {
    broadcastDir = resolve(CONTRACTS_DIR, 'broadcast', 'Deploy.s.sol', String(chainId));
  }

  return { chainId, broadcastDir, networksFile, networkAlias, force };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: tsx contracts/scripts/post-deploy.ts [flags]',
      '',
      'Flags:',
      '  --chain-id <id>         default 5042002 (Arc Testnet)',
      '  --broadcast-dir <path>  default contracts/broadcast/Deploy.s.sol/<chain-id>',
      '  --networks-file <path>  default packages/middleware/src/networks.ts',
      '  --network-alias <a>     default arc-testnet',
      '  --force                 overwrite already-populated arc-testnet addresses',
      '  --help, -h              show this message',
      '',
    ].join('\n'),
  );
}

function extractAddresses(
  broadcast: unknown,
  broadcastPath: string,
): { factoryAddress: string; vaultImplAddress: string } {
  if (
    typeof broadcast !== 'object' ||
    broadcast === null ||
    !Array.isArray((broadcast as ForgeBroadcast).transactions)
  ) {
    throw new Error(
      `forge broadcast schema error: missing transactions[] at ${broadcastPath} (forge version drift? see post-deploy.ts comments)`,
    );
  }

  const txs = (broadcast as ForgeBroadcast).transactions ?? [];
  const factoryTx = txs.find((t) => t.contractName === 'PaymentSplitterFactory');

  if (!factoryTx) {
    throw new Error(`forge broadcast missing PaymentSplitterFactory deploy tx at ${broadcastPath}`);
  }

  const factoryAddress = factoryTx.contractAddress;
  if (!factoryAddress || !ADDRESS_RE.test(factoryAddress)) {
    throw new Error(
      `forge broadcast: PaymentSplitterFactory contractAddress missing or malformed (got ${String(factoryAddress)}) at ${broadcastPath}`,
    );
  }

  const additional = factoryTx.additionalContracts ?? [];
  if (additional.length === 0) {
    throw new Error(
      `forge broadcast: factory tx has no additionalContracts[] — expected the inner PaymentVaultImpl CREATE; check T4's PaymentSplitterFactory constructor (broadcast file: ${broadcastPath})`,
    );
  }

  const vaultImplEntry = additional[0];
  const vaultImplAddress = vaultImplEntry?.address;
  if (!vaultImplAddress || !ADDRESS_RE.test(vaultImplAddress)) {
    throw new Error(
      `forge broadcast: additionalContracts[0].address missing or malformed (got ${String(vaultImplAddress)}) at ${broadcastPath}`,
    );
  }

  return { factoryAddress, vaultImplAddress };
}

function applySubstitution(
  source: string,
  factoryAddress: string,
  vaultImplAddress: string,
  networksFile: string,
): string {
  if (!FACTORY_SENTINEL_RE.test(source)) {
    throw new Error(
      `${networksFile} is missing deploy-script sentinel comment for factoryAddress — see Task 6`,
    );
  }
  if (!VAULT_IMPL_SENTINEL_RE.test(source)) {
    throw new Error(
      `${networksFile} is missing deploy-script sentinel comment for vaultImplAddress — see Task 6`,
    );
  }

  return source
    .replace(
      FACTORY_SENTINEL_RE,
      (_m, openQ: string, _closeQ: string, ws: string) =>
        `${openQ}${factoryAddress}${openQ}${ws}/* deploy-script:factoryAddress */`,
    )
    .replace(
      VAULT_IMPL_SENTINEL_RE,
      (_m, openQ: string, _closeQ: string, ws: string) =>
        `${openQ}${vaultImplAddress}${openQ}${ws}/* deploy-script:vaultImplAddress */`,
    );
}

function extractCurrentAddresses(source: string): {
  factory: string | undefined;
  vaultImpl: string | undefined;
} {
  const fm = source.match(FACTORY_SENTINEL_RE);
  const vm = source.match(VAULT_IMPL_SENTINEL_RE);
  const fAddr = fm?.[0]?.match(/0x[0-9a-fA-F]{40}/)?.[0];
  const vAddr = vm?.[0]?.match(/0x[0-9a-fA-F]{40}/)?.[0];
  return { factory: fAddr, vaultImpl: vAddr };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const broadcastPath = resolve(args.broadcastDir, 'run-latest.json');
  let raw: string;
  try {
    raw = readFileSync(broadcastPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `broadcast artifact not found at ${broadcastPath} — run \`forge script script/Deploy.s.sol:Deploy --rpc-url <url> --broadcast\` first`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Static message per security-auditor SA-T11-03: do not forward the
    // inner JSON parse error message, which could (in pathological inputs)
    // echo a secret-shaped substring.
    throw new Error(
      `failed to parse broadcast JSON at ${broadcastPath} (malformed JSON; re-run forge script)`,
    );
  }

  const { factoryAddress, vaultImplAddress } = extractAddresses(parsed, broadcastPath);

  const networksSource = readFileSync(args.networksFile, 'utf8');

  if (args.chainId !== 31337 && !args.force) {
    const current = extractCurrentAddresses(networksSource);
    if (
      current.factory &&
      current.vaultImpl &&
      current.factory.toLowerCase() !== ZERO_ADDRESS &&
      current.vaultImpl.toLowerCase() !== ZERO_ADDRESS
    ) {
      process.stderr.write(
        `networks.ts already has non-zero addresses for ${args.networkAlias} — pass --force to overwrite\n`,
      );
      process.exit(4);
    }
  }

  const updated = applySubstitution(
    networksSource,
    factoryAddress,
    vaultImplAddress,
    args.networksFile,
  );

  if (updated !== networksSource) {
    writeFileSync(args.networksFile, updated);
  }

  process.stdout.write(`FACTORY_ADDRESS=${factoryAddress}\n`);
  process.stdout.write(`VAULT_IMPL_ADDRESS=${vaultImplAddress}\n`);

  if (args.chainId === 31337) {
    process.stderr.write(
      'note: chain-id 31337 (local anvil) — networks.ts has been edited in place; revert before committing if this was a smoke run.\n',
    );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`post-deploy: ${(err as Error).message}\n`);
  process.exit(1);
}
