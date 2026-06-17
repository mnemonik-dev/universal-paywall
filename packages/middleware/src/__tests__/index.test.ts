import { describe, expect, it } from 'vitest';

describe('public exports — @universal-paywall/middleware', () => {
  it('exports exactly the documented value surface — withPaywall, fastifyPaywall, NETWORKS, OpaqueRelayerKey', async () => {
    const mod = await import('../index.js');
    const valueKeys = Object.keys(mod).sort();
    expect(valueKeys).toEqual(['NETWORKS', 'OpaqueRelayerKey', 'fastifyPaywall', 'withPaywall']);
  });

  it('internal helpers are NOT exported — verify, settle, replay-store, FactoryStateCache, getRelayerKeySecret', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    expect(mod['verifyEip3009Authorization']).toBeUndefined();
    expect(mod['settleOnChain']).toBeUndefined();
    expect(mod['NonceStore']).toBeUndefined();
    expect(mod['getRelayerKeySecret']).toBeUndefined();
    expect(mod['FactoryStateCache']).toBeUndefined();
    expect(mod['__resetCoreCachesForTests']).toBeUndefined();
    expect(mod['__getNonceStoreForTests']).toBeUndefined();
    expect(mod['__resetSettleCacheForTests']).toBeUndefined();
  });

  it('NETWORKS is the registry from networks.ts', async () => {
    const { NETWORKS } = await import('../index.js');
    expect(NETWORKS['arc-testnet']).toBeDefined();
    expect(NETWORKS['arc-testnet']!.alias).toBe('arc-testnet');
  });

  it('OpaqueRelayerKey constructor accepts a non-empty string', async () => {
    const { OpaqueRelayerKey } = await import('../index.js');
    const k = new OpaqueRelayerKey('0xabc');
    expect(OpaqueRelayerKey.is(k)).toBe(true);
  });
});
