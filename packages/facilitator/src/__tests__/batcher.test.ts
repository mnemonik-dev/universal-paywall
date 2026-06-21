import { describe, expect, it } from 'vitest';
import { buildBatch } from '../batcher.js';
import type { Hex, RecordedCharge } from '../types.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const VAULT = '0x9999999999999999999999999999999999999999' as Hex;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;

function charge(id: string, creator: Hex, amount: bigint): RecordedCharge {
  return { id, payer: PAYER, creator, amount, receivedAt: 0 };
}

describe('buildBatch', () => {
  it('aggregates amounts per creator', () => {
    const batch = buildBatch(PAYER, VAULT, [
      charge('c1', A, 100n),
      charge('c2', B, 250n),
      charge('c3', A, 50n),
    ]);

    expect(batch.vault).toBe(VAULT);
    expect(batch.total).toBe(400n);
    expect(batch.chargeIds).toEqual(['c1', 'c2', 'c3']);

    // A aggregated to 150, B to 250, one entry each.
    const map = new Map(batch.creators.map((c, i) => [c, batch.amounts[i]]));
    expect(map.get(A)).toBe(150n);
    expect(map.get(B)).toBe(250n);
    expect(batch.creators).toHaveLength(2);
  });

  it('handles a single charge', () => {
    const batch = buildBatch(PAYER, VAULT, [charge('c1', A, 42n)]);
    expect(batch.creators).toEqual([A]);
    expect(batch.amounts).toEqual([42n]);
    expect(batch.total).toBe(42n);
  });

  it('produces empty arrays for no charges', () => {
    const batch = buildBatch(PAYER, VAULT, []);
    expect(batch.creators).toHaveLength(0);
    expect(batch.total).toBe(0n);
  });
});
