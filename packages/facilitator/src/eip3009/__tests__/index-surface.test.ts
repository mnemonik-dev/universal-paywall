/**
 * Guards the published `@universal-paywall/facilitator/eip3009` surface.
 *
 * The containment contract (D13 + U1 review round 1) requires that the raw
 * relayer-key extractor and the settle-cache test hook never appear on the
 * public subpath — they are importable only by module path from inside this
 * package (and the repo-root register CLI). A re-export added in a refactor
 * would silently hand every npm consumer a one-call key extractor, so the
 * absence is pinned here, mirroring middleware's index.test.ts.
 */

import { describe, expect, it } from 'vitest';
import * as eip3009 from '../index.js';

describe('eip3009 public surface', () => {
  it('never exposes the relayer-key extractor or test hooks', () => {
    const mod = eip3009 as Record<string, unknown>;
    expect(mod['getRelayerKeySecret']).toBeUndefined();
    expect(mod['__resetSettleCacheForTests']).toBeUndefined();
  });

  it('exposes exactly the nine exact-scheme core exports', () => {
    expect(Object.keys(eip3009).sort()).toEqual([
      'MIN_RELAYER_USDC_BALANCE',
      'NETWORKS',
      'NetworkMismatchError',
      'NonceStore',
      'OpaqueRelayerKey',
      'normalizeNetworkId',
      'scrubSecrets',
      'settleOnChain',
      'verifyEip3009Authorization',
    ]);
  });

  it('exposes the exact-scheme core', () => {
    expect(eip3009.verifyEip3009Authorization).toBeTypeOf('function');
    expect(eip3009.settleOnChain).toBeTypeOf('function');
    expect(eip3009.normalizeNetworkId).toBeTypeOf('function');
    expect(eip3009.scrubSecrets).toBeTypeOf('function');
    expect(eip3009.OpaqueRelayerKey).toBeTypeOf('function');
    expect(eip3009.NonceStore).toBeTypeOf('function');
    expect(eip3009.NetworkMismatchError).toBeTypeOf('function');
    expect(eip3009.NETWORKS).toBeTypeOf('object');
    expect(eip3009.MIN_RELAYER_USDC_BALANCE).toBeTypeOf('bigint');
  });
});
