import type { ChargeRequest, Hex, RecordedCharge } from './types.js';

/**
 * In-memory pending-charge store, keyed by payer. Pure and synchronous — the
 * unit-testable heart of the facilitator. A production deployment would back
 * this with a durable store, but the interface stays the same.
 */
export class ChargeLedger {
  private readonly pending = new Map<Hex, RecordedCharge[]>();
  private readonly byRef = new Map<string, RecordedCharge>();
  private seq = 0;

  /** Records a charge. If `ref` was seen before, returns the existing record (idempotent). */
  add(req: ChargeRequest, now: number = Date.now()): RecordedCharge {
    if (req.ref !== undefined) {
      const existing = this.byRef.get(req.ref);
      if (existing !== undefined) return existing;
    }

    const record: RecordedCharge = {
      ...req,
      id: `c_${++this.seq}`,
      receivedAt: now,
    };

    const list = this.pending.get(req.payer);
    if (list === undefined) {
      this.pending.set(req.payer, [record]);
    } else {
      list.push(record);
    }
    if (req.ref !== undefined) this.byRef.set(req.ref, record);

    return record;
  }

  pendingFor(payer: Hex): readonly RecordedCharge[] {
    return this.pending.get(payer) ?? [];
  }

  /** Removes and returns all pending charges for a payer. */
  drain(payer: Hex): RecordedCharge[] {
    const list = this.pending.get(payer);
    if (list === undefined || list.length === 0) return [];
    this.pending.delete(payer);
    return list;
  }

  /** Restores charges to the front of a payer's queue (e.g. after a failed settle). */
  requeue(payer: Hex, charges: readonly RecordedCharge[]): void {
    if (charges.length === 0) return;
    const list = this.pending.get(payer);
    if (list === undefined) {
      this.pending.set(payer, [...charges]);
    } else {
      list.unshift(...charges);
    }
  }

  payersWithPending(): Hex[] {
    const out: Hex[] = [];
    for (const [payer, list] of this.pending) {
      if (list.length > 0) out.push(payer);
    }
    return out;
  }

  size(): number {
    let n = 0;
    for (const list of this.pending.values()) n += list.length;
    return n;
  }
}
