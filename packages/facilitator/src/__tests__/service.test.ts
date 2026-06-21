import { describe, expect, it, vi } from 'vitest';
import { ChargeLedger } from '../ledger.js';
import { FacilitatorService } from '../service.js';
import type { Hex, SettlementBatch, Settler } from '../types.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const VAULT = '0x9999999999999999999999999999999999999999' as Hex;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;

function makeService(settler: Settler, opts?: { maxCharges?: number; maxAgeMs?: number; now?: () => number }) {
  const ledger = new ChargeLedger();
  const service = new FacilitatorService({
    ledger,
    resolveVault: async () => VAULT,
    settler,
    batch: { maxCharges: opts?.maxCharges ?? 3, maxAgeMs: opts?.maxAgeMs ?? 10_000 },
    ...(opts?.now ? { now: opts.now } : {}),
  });
  return { ledger, service };
}

describe('FacilitatorService', () => {
  it('rejects non-positive amounts', () => {
    const { service } = makeService({ settle: async () => ({ ok: true }) });
    expect(() => service.charge({ payer: PAYER, creator: A, amount: 0n })).toThrow('amount_must_be_positive');
  });

  it('flushes a payer into one batched settlement', async () => {
    const settle = vi.fn(async (b: SettlementBatch) => ({ ok: true, txHash: '0xabc' as Hex }));
    const { ledger, service } = makeService({ settle });

    service.charge({ payer: PAYER, creator: A, amount: 100n });
    service.charge({ payer: PAYER, creator: A, amount: 50n });

    const result = await service.flushPayer(PAYER);
    expect(result?.ok).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);

    const batch = settle.mock.calls[0]![0];
    expect(batch.vault).toBe(VAULT);
    expect(batch.total).toBe(150n);
    expect(batch.creators).toEqual([A]); // aggregated
    expect(ledger.pendingFor(PAYER)).toHaveLength(0);
  });

  it('requeues charges when settlement fails', async () => {
    const { ledger, service } = makeService({ settle: async () => ({ ok: false, reason: 'rpc_timeout' }) });
    service.charge({ payer: PAYER, creator: A, amount: 100n });

    const result = await service.flushPayer(PAYER);
    expect(result?.ok).toBe(false);
    expect(ledger.pendingFor(PAYER)).toHaveLength(1); // restored for retry
  });

  it('shouldFlush triggers at the count threshold', () => {
    const { service } = makeService({ settle: async () => ({ ok: true }) }, { maxCharges: 2 });
    service.charge({ payer: PAYER, creator: A, amount: 1n });
    expect(service.shouldFlush(PAYER)).toBe(false);
    service.charge({ payer: PAYER, creator: A, amount: 1n });
    expect(service.shouldFlush(PAYER)).toBe(true);
  });

  it('shouldFlush triggers at the age threshold', () => {
    let t = 1_000;
    const { service } = makeService(
      { settle: async () => ({ ok: true }) },
      { maxCharges: 99, maxAgeMs: 5_000, now: () => t },
    );
    service.charge({ payer: PAYER, creator: A, amount: 1n });
    expect(service.shouldFlush(PAYER)).toBe(false);
    t = 6_500; // 5.5s later
    expect(service.shouldFlush(PAYER)).toBe(true);
  });

  it('flushDue only settles payers past threshold', async () => {
    const settle = vi.fn(async () => ({ ok: true }));
    const { service } = makeService({ settle }, { maxCharges: 2 });
    service.charge({ payer: PAYER, creator: A, amount: 1n }); // 1 < 2 → not due
    await service.flushDue();
    expect(settle).not.toHaveBeenCalled();

    service.charge({ payer: PAYER, creator: A, amount: 1n }); // now 2 → due
    await service.flushDue();
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
