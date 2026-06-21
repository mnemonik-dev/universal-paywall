import type { Hex, RecordedCharge, SettlementBatch } from './types.js';

/**
 * Collapses many charges for one payer into a compact settlement batch:
 * amounts are summed per creator so the on-chain `settle(creators, amounts)`
 * arrays carry one entry per distinct payee, not one per charge. This is what
 * turns N micro-charges into a single, gas-amortized settlement.
 */
export function buildBatch(
  payer: Hex,
  vault: Hex,
  charges: readonly RecordedCharge[],
): SettlementBatch {
  const perCreator = new Map<Hex, bigint>();
  const chargeIds: string[] = [];
  let total = 0n;

  for (const c of charges) {
    perCreator.set(c.creator, (perCreator.get(c.creator) ?? 0n) + c.amount);
    chargeIds.push(c.id);
    total += c.amount;
  }

  const creators: Hex[] = [];
  const amounts: bigint[] = [];
  for (const [creator, amount] of perCreator) {
    creators.push(creator);
    amounts.push(amount);
  }

  return { payer, vault, creators, amounts, chargeIds, total };
}
