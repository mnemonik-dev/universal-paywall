import { describe, expect, it } from 'vitest';
import { ChargeLedger } from '../ledger.js';
import type { Hex } from '../types.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const CREATOR = '0x2222222222222222222222222222222222222222' as Hex;

describe('ChargeLedger', () => {
  it('records and lists pending charges per payer', () => {
    const l = new ChargeLedger();
    l.add({ payer: PAYER, creator: CREATOR, amount: 10n });
    l.add({ payer: PAYER, creator: CREATOR, amount: 20n });
    expect(l.pendingFor(PAYER)).toHaveLength(2);
    expect(l.size()).toBe(2);
  });

  it('drains pending charges and empties the queue', () => {
    const l = new ChargeLedger();
    l.add({ payer: PAYER, creator: CREATOR, amount: 10n });
    const drained = l.drain(PAYER);
    expect(drained).toHaveLength(1);
    expect(l.pendingFor(PAYER)).toHaveLength(0);
  });

  it('is idempotent on repeated ref', () => {
    const l = new ChargeLedger();
    const a = l.add({ payer: PAYER, creator: CREATOR, amount: 10n, ref: 'r1' });
    const b = l.add({ payer: PAYER, creator: CREATOR, amount: 10n, ref: 'r1' });
    expect(a.id).toBe(b.id);
    expect(l.size()).toBe(1);
  });

  it('requeues charges to the front', () => {
    const l = new ChargeLedger();
    l.add({ payer: PAYER, creator: CREATOR, amount: 10n });
    const drained = l.drain(PAYER);
    l.requeue(PAYER, drained);
    expect(l.pendingFor(PAYER)).toHaveLength(1);
  });

  it('lists only payers with pending charges', () => {
    const l = new ChargeLedger();
    l.add({ payer: PAYER, creator: CREATOR, amount: 10n });
    expect(l.payersWithPending()).toEqual([PAYER]);
    l.drain(PAYER);
    expect(l.payersWithPending()).toEqual([]);
  });
});
