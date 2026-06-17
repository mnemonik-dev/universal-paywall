import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NETWORKS, normalizeNetworkId } from '../networks.js';

const T3_ARTEFACT_PATH = resolve(
  __dirname,
  '../../../../contracts/scripts/arc-testnet-usdc-domain.json',
);
const t3 = JSON.parse(readFileSync(T3_ARTEFACT_PATH, 'utf8')) as {
  name: string;
  version: string;
};

describe('NETWORKS registry', () => {
  it("keys 'arc-testnet' and 'eip155:5042002' are the SAME reference", () => {
    expect(NETWORKS['arc-testnet']).toBe(NETWORKS['eip155:5042002']);
  });

  it('arc-testnet row has enabled false until Task 11', () => {
    expect(NETWORKS['arc-testnet'].enabled).toBe(false);
  });

  it('arc-testnet row uses the canonical USDC address', () => {
    expect(NETWORKS['arc-testnet'].usdcAddress).toBe('0x3600000000000000000000000000000000000000');
  });

  it('arc-testnet row uses canonical CAIP-2 and chainId 5042002', () => {
    expect(NETWORKS['arc-testnet'].id).toBe('eip155:5042002');
    expect(NETWORKS['arc-testnet'].alias).toBe('arc-testnet');
    expect(NETWORKS['arc-testnet'].chainId).toBe(5042002);
  });

  it('arc-testnet usdcEip712Name + version match T3 JSON artefact', () => {
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
