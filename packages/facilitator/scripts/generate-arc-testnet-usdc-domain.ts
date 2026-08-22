#!/usr/bin/env tsx
/**
 * Build-time codegen: read T3's canonical USDC EIP-712 domain artefact
 * (`contracts/scripts/arc-testnet-usdc-domain.json`) and emit a TypeScript
 * module under `src/eip3009/generated/` that exports the same values as a const.
 *
 * Why: networks.ts previously did `readFileSync(...../contracts/scripts/...)`
 * at module load. That works inside the monorepo (relative path resolves) but
 * crashes after `npm install` because the published `dist/` lives under
 * `node_modules/@universal-paywall/facilitator/` with no `contracts/` sibling.
 *
 * This generator preserves the single source of truth (the JSON file owned by
 * Task 3) while making the values part of the published bundle.
 *
 * Idempotent: re-running with no JSON change is a no-op write.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../..');
const JSON_PATH = resolve(REPO_ROOT, 'contracts/scripts/arc-testnet-usdc-domain.json');
const OUT_DIR = resolve(here, '../src/eip3009/generated');
const OUT_PATH = resolve(OUT_DIR, 'arc-testnet-usdc-domain.ts');

interface ArcTestnetUsdcDomain {
  name: string;
  version: string;
  decimals: number;
  supportsEip3009: boolean;
  sampleGasCost?: string;
  gasCostExceedsThreshold?: boolean;
  notes?: string[];
}

function main(): void {
  if (!existsSync(JSON_PATH)) {
    // Outside the full monorepo (Docker image build, published-package
    // consumers) the contracts/ tree is absent by design. The committed
    // generated module is the shipped source of truth there — keep it and
    // no-op instead of failing the build.
    if (existsSync(OUT_PATH)) {
      process.stdout.write(
        `T3 USDC domain artefact not found at ${JSON_PATH}; keeping committed ${OUT_PATH}\n`,
      );
      return;
    }
    throw new Error(
      `T3 USDC domain artefact missing at ${JSON_PATH} — run T3 first (or this script before publish).`,
    );
  }

  const parsed = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as ArcTestnetUsdcDomain;
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error(
      `T3 USDC domain artefact at ${JSON_PATH} is missing required fields (name, version).`,
    );
  }
  if (typeof parsed.decimals !== 'number' || !Number.isInteger(parsed.decimals)) {
    throw new Error(
      `T3 USDC domain artefact at ${JSON_PATH} has invalid decimals (expected integer, got ${typeof parsed.decimals}).`,
    );
  }
  if (typeof parsed.supportsEip3009 !== 'boolean') {
    throw new Error(
      `T3 USDC domain artefact at ${JSON_PATH} has invalid supportsEip3009 (expected boolean, got ${typeof parsed.supportsEip3009}).`,
    );
  }
  if (parsed.sampleGasCost !== undefined && typeof parsed.sampleGasCost !== 'string') {
    throw new Error(
      `T3 USDC domain artefact at ${JSON_PATH} has invalid sampleGasCost (expected string or absent).`,
    );
  }
  if (
    parsed.gasCostExceedsThreshold !== undefined &&
    typeof parsed.gasCostExceedsThreshold !== 'boolean'
  ) {
    throw new Error(
      `T3 USDC domain artefact at ${JSON_PATH} has invalid gasCostExceedsThreshold (expected boolean or absent).`,
    );
  }

  const emitted = {
    name: parsed.name,
    version: parsed.version,
    decimals: parsed.decimals,
    supportsEip3009: parsed.supportsEip3009,
    sampleGasCost: parsed.sampleGasCost ?? null,
    gasCostExceedsThreshold: parsed.gasCostExceedsThreshold ?? false,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  };
  if (emitted.notes.some((n) => typeof n !== 'string')) {
    throw new Error(`T3 USDC domain artefact at ${JSON_PATH} has non-string entries in notes[].`);
  }

  // Emit a prettier-stable object literal (bare keys, trailing commas,
  // prettier's fewer-escapes quote choice) so a prebuild refresh never
  // dirties the committed file. Control characters are unicode-escaped --
  // a raw newline would otherwise emit an unterminated literal.
  const q = (s: string): string => {
    const escaped = s
      .replace(/\\/g, '\\\\')
      // eslint-disable-next-line no-control-regex
      .replace(
        /[\u0000-\u001f\u007f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
    const singles = (escaped.match(/'/g) ?? []).length;
    const doubles = (escaped.match(/"/g) ?? []).length;
    return singles > doubles
      ? `"${escaped.replace(/"/g, '\\"')}"`
      : `'${escaped.replace(/'/g, "\\'")}'`;
  };
  const literalLines: string[] = ['{'];
  for (const [key, value] of Object.entries(emitted)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        literalLines.push(`  ${key}: [],`);
      } else {
        literalLines.push(`  ${key}: [`);
        for (const item of value) {
          literalLines.push(`    ${q(String(item))},`);
        }
        literalLines.push('  ],');
      }
    } else if (typeof value === 'string') {
      literalLines.push(`  ${key}: ${q(value)},`);
    } else {
      literalLines.push(`  ${key}: ${String(value)},`);
    }
  }
  literalLines.push('}');
  const literal = literalLines.join('\n');

  const body = [
    '// AUTO-GENERATED by scripts/generate-arc-testnet-usdc-domain.ts.',
    '// Source of truth: contracts/scripts/arc-testnet-usdc-domain.json (Task 3).',
    '// Do not edit by hand; re-run `npm run build` (which triggers prebuild) to refresh.',
    '',
    'export interface ArcTestnetUsdcDomain {',
    '  name: string;',
    '  version: string;',
    '  decimals: number;',
    '  supportsEip3009: boolean;',
    '  sampleGasCost: string | null;',
    '  gasCostExceedsThreshold: boolean;',
    '  notes: string[];',
    '}',
    '',
    `export const arcTestnetUsdcDomain: ArcTestnetUsdcDomain = ${literal} as const;`,
    '',
  ].join('\n');

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  let prev = '';
  if (existsSync(OUT_PATH)) {
    prev = readFileSync(OUT_PATH, 'utf8');
  }
  if (prev !== body) {
    writeFileSync(OUT_PATH, body);
    process.stdout.write(`wrote ${OUT_PATH}\n`);
  } else {
    process.stdout.write(`up to date: ${OUT_PATH}\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`generate-arc-testnet-usdc-domain: ${(err as Error).message}\n`);
  process.exit(1);
}
