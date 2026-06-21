import { buildBatch } from './batcher.js';
import { ChargeLedger } from './ledger.js';
import type { ChargeRequest, Hex, RecordedCharge, SettleResult, Settler, VaultResolver } from './types.js';

export interface ServiceOptions {
  ledger: ChargeLedger;
  resolveVault: VaultResolver;
  settler: Settler;
  batch: { maxCharges: number; maxAgeMs: number };
  now?: () => number;
}

/**
 * Orchestrates the facilitator: accepts metered charges, batches them per payer,
 * and settles a batch once it reaches `maxCharges` or ages past `maxAgeMs`.
 * On settlement failure the batch is requeued for the next cycle.
 */
export class FacilitatorService {
  private readonly ledger: ChargeLedger;
  private readonly resolveVault: VaultResolver;
  private readonly settler: Settler;
  private readonly maxCharges: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: ServiceOptions) {
    this.ledger = opts.ledger;
    this.resolveVault = opts.resolveVault;
    this.settler = opts.settler;
    this.maxCharges = opts.batch.maxCharges;
    this.maxAgeMs = opts.batch.maxAgeMs;
    this.now = opts.now ?? Date.now;
  }

  /** Validates and records a charge. */
  charge(req: ChargeRequest): RecordedCharge {
    if (req.amount <= 0n) throw new Error('amount_must_be_positive');
    return this.ledger.add(req, this.now());
  }

  /** True when a payer's pending charges have hit the count or age threshold. */
  shouldFlush(payer: Hex): boolean {
    const pending = this.ledger.pendingFor(payer);
    if (pending.length === 0) return false;
    if (pending.length >= this.maxCharges) return true;
    const oldest = pending[0];
    return oldest !== undefined && this.now() - oldest.receivedAt >= this.maxAgeMs;
  }

  /** Settles all pending charges for one payer in a single batched tx. */
  async flushPayer(payer: Hex): Promise<SettleResult | null> {
    if (this.ledger.pendingFor(payer).length === 0) return null;
    const vault = await this.resolveVault(payer);
    const charges = this.ledger.drain(payer);
    const batch = buildBatch(payer, vault, charges);
    const result = await this.settler.settle(batch);
    if (!result.ok) this.ledger.requeue(payer, charges);
    return result;
  }

  /** Flushes every payer whose batch is due. */
  async flushDue(): Promise<SettleResult[]> {
    const out: SettleResult[] = [];
    for (const payer of this.ledger.payersWithPending()) {
      if (this.shouldFlush(payer)) {
        const r = await this.flushPayer(payer);
        if (r !== null) out.push(r);
      }
    }
    return out;
  }

  /** Flushes every payer with pending charges, regardless of threshold. */
  async flushAll(): Promise<SettleResult[]> {
    const out: SettleResult[] = [];
    for (const payer of this.ledger.payersWithPending()) {
      const r = await this.flushPayer(payer);
      if (r !== null) out.push(r);
    }
    return out;
  }

  start(intervalMs = 1000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.flushDue();
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
