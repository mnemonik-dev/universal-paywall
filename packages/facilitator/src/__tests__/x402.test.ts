import { describe, expect, it } from 'vitest';
import { build402Body, checkGrant, type OnChainPolicy, type PolicyReader } from '../x402.js';
import type { Hex } from '../types.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const VAULT = '0x9999999999999999999999999999999999999999' as Hex;
const FAC = '0xfac0000000000000000000000000000000000000' as Hex;
const OTHER = '0x0000000000000000000000000000000000000abc' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
const USDC = '0x3600000000000000000000000000000000000000' as Hex;

function reader(p: Partial<OnChainPolicy>): PolicyReader {
  const policy: OnChainPolicy = {
    facilitator: p.facilitator ?? FAC,
    cap: p.cap ?? 1_000_000n,
    spent: p.spent ?? 0n,
    validUntil: p.validUntil ?? 10_000n,
    epoch: p.epoch ?? 1n,
  };
  return async () => policy;
}

describe('build402Body', () => {
  it('produces an x402 stake-scheme 402 with grant instructions', () => {
    const body = build402Body({
      payer: PAYER,
      vault: VAULT,
      network: 'eip155:5042002',
      asset: USDC,
      facilitator: FAC,
      stakeVaultFactory: '0xf00d000000000000000000000000000000000000',
      recommendedCap: 1_000_000n,
      resource: 'https://api.example.com/paid',
    });

    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]!.scheme).toBe('stake');
    expect(body.accepts[0]!.payTo).toBe(VAULT);
    expect(body.accepts[0]!.maxAmountRequired).toBe('1000000');
    expect(body.grant.facilitator).toBe(FAC);
    expect(body.grant.validForSeconds).toBe(3600);
    expect(body.resource).toBe('https://api.example.com/paid');
  });
});

describe('checkGrant', () => {
  const base = { vault: VAULT, facilitator: FAC, minRemaining: 100n, now: 1_000 };

  it('passes with an active, funded grant', async () => {
    const res = await checkGrant(reader({}), base);
    expect(res.ok).toBe(true);
    expect(res.remaining).toBe(1_000_000n);
  });

  it('fails when no grant exists', async () => {
    const res = await checkGrant(reader({ facilitator: ZERO }), base);
    expect(res).toMatchObject({ ok: false, reason: 'no_grant' });
  });

  it('fails when granted to a different facilitator', async () => {
    const res = await checkGrant(reader({ facilitator: OTHER }), base);
    expect(res).toMatchObject({ ok: false, reason: 'grant_to_other_facilitator' });
  });

  it('fails when expired', async () => {
    const res = await checkGrant(reader({ validUntil: 500n }), base);
    expect(res).toMatchObject({ ok: false, reason: 'grant_expired' });
  });

  it('fails when remaining headroom is below the minimum', async () => {
    const res = await checkGrant(reader({ cap: 1_000n, spent: 950n }), { ...base, minRemaining: 100n });
    expect(res).toMatchObject({ ok: false, reason: 'insufficient_remaining', remaining: 50n });
  });
});
