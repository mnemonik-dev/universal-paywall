import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NETWORKS, normalizeNetworkId } from '../networks.js';

const here = dirname(fileURLToPath(import.meta.url));
const T3_ARTEFACT_PATH = resolve(
  here,
  '../../../../contracts/scripts/arc-testnet-usdc-domain.json',
);

// On a cold checkout (T3 hasn't run yet) the artefact is absent and the
// import of `../networks.js` above will already have thrown — so reaching
// this line means the file IS present. We still guard the read so a future
// race between T3 and T9 produces a descriptive skip rather than a raw
// ENOENT crash.
const t3Available = existsSync(T3_ARTEFACT_PATH);
const t3: { name: string; version: string } = t3Available
  ? (JSON.parse(readFileSync(T3_ARTEFACT_PATH, 'utf8')) as { name: string; version: string })
  : { name: '', version: '' };
const itIfT3 = t3Available ? it : it.skip;

describe('NETWORKS registry', () => {
  it("keys 'arc-testnet' and 'eip155:5042002' are the SAME reference", () => {
    expect(NETWORKS['arc-testnet']).toBe(NETWORKS['eip155:5042002']);
  });

  it('arc-testnet row is enabled after Task 16 live deploy', () => {
    expect(NETWORKS['arc-testnet'].enabled).toBe(true);
  });

  it('arc-testnet row uses the canonical USDC address', () => {
    expect(NETWORKS['arc-testnet'].usdcAddress).toBe('0x3600000000000000000000000000000000000000');
  });

  it('arc-testnet row uses canonical CAIP-2 and chainId 5042002', () => {
    expect(NETWORKS['arc-testnet'].id).toBe('eip155:5042002');
    expect(NETWORKS['arc-testnet'].alias).toBe('arc-testnet');
    expect(NETWORKS['arc-testnet'].chainId).toBe(5042002);
  });

  itIfT3('arc-testnet usdcEip712Name + version match T3 JSON artefact', () => {
    expect(NETWORKS['arc-testnet'].usdcEip712Name).toBe(t3.name);
    expect(NETWORKS['arc-testnet'].usdcEip712Version).toBe(t3.version);
  });

  it('arc-mainnet placeholder uses chainId 0 and id eip155:0', () => {
    expect(NETWORKS['arc-mainnet'].chainId).toBe(0);
    expect(NETWORKS['arc-mainnet'].id).toBe('eip155:0');
    expect(NETWORKS['arc-mainnet'].enabled).toBe(false);
  });

  it("arc-mainnet keys 'arc-mainnet' and 'eip155:0' are the same reference", () => {
    expect(NETWORKS['arc-mainnet']).toBe(NETWORKS['eip155:0']);
  });
});

describe('normalizeNetworkId', () => {
  it('returns canonical for both forms of arc-testnet', () => {
    expect(normalizeNetworkId('arc-testnet')).toBe('eip155:5042002');
    expect(normalizeNetworkId('eip155:5042002')).toBe('eip155:5042002');
  });

  it('returns canonical for both forms of arc-mainnet placeholder', () => {
    expect(normalizeNetworkId('arc-mainnet')).toBe('eip155:0');
    expect(normalizeNetworkId('eip155:0')).toBe('eip155:0');
  });

  it('returns undefined for unknown id', () => {
    expect(normalizeNetworkId('eip155:1')).toBeUndefined();
    expect(normalizeNetworkId('mainnet')).toBeUndefined();
    expect(normalizeNetworkId('')).toBeUndefined();
  });
});
