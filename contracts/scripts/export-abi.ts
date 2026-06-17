/**
 * Post-build ABI export hook for @universal-paywall/contracts.
 *
 * Runs as a post-step of `forge build` (chained in the workspace `build`
 * script). For each contract listed in CONTRACTS, reads the forge artifact at
 *   contracts/out/<Contract>.sol/<Contract>.json
 * extracts the `abi` field, and writes a typed JSON file to
 *   packages/middleware/src/abi/<Contract>.json
 * for viem consumption.
 *
 * Consumers: Task 7 (settle.ts) and Task 10 (forked integration test) read
 * `@universal-paywall/middleware/abi/<Contract>.json` to interact with the
 * deployed factory + vault implementation.
 *
 * Idempotent: re-runs overwrite existing destination files. Safe no-op when
 * `contracts/out/` is absent or a given source JSON does not exist yet — Task 2
 * commits this hook before any Solidity sources exist, so `forge build`
 * produces no output and the script must succeed without errors.
 *
 * ESM only (`contracts/package.json` is `"type": "module"`). `require()` is
 * forbidden; use `import` and `fileURLToPath(import.meta.url)` for path math.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS = ['PaymentSplitterFactory', 'PaymentVaultImpl'] as const;

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, '..');
const outDir = resolve(contractsRoot, 'out');
const destDir = resolve(contractsRoot, '..', 'packages', 'middleware', 'src', 'abi');

if (!existsSync(outDir)) {
  console.warn(`[export-abi] skip: forge output directory not found at ${outDir}`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

for (const name of CONTRACTS) {
  const sourcePath = resolve(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(sourcePath)) {
    console.warn(`[export-abi] skip ${name}: no artifact at ${sourcePath}`);
    continue;
  }

  const artifact = JSON.parse(readFileSync(sourcePath, 'utf8')) as { abi?: unknown };
  if (!artifact.abi) {
    console.warn(`[export-abi] skip ${name}: artifact has no \`abi\` field`);
    continue;
  }

  const destPath = resolve(destDir, `${name}.json`);
  writeFileSync(destPath, `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`[export-abi] wrote ${destPath}`);
}
