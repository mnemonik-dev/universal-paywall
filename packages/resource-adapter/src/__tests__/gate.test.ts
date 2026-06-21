import { describe, expect, it } from 'vitest';
import type { Hex } from '@universal-paywall/facilitator';
import { evaluateAccess, proofMessage, type GateConfig, type GateDeps } from '../gate.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const OTHER = '0x2222222222222222222222222222222222222222' as Hex;
const VAULT = '0x9999999999999999999999999999999999999999' as Hex;
const FAC = '0xfac0000000000000000000000000000000000000' as Hex;
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
const USDC = '0x3600000000000000000000000000000000000000' as Hex;
const FACTORY = '0xf00d000000000000000000000000000000000000' as Hex;
const SIG = '0xdeadbeef' as Hex;
const NOW_MS = 1_000_000; // nowSec = 1000

const cfg: GateConfig = {
  network: 'eip155:5042002',
  asset: USDC,
  facilitatorAddress: FAC,
  stakeVaultFactory: FACTORY,
  price: 10_000n,
};

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    resolveVault: async () => VAULT,
    readPolicy: async () => ({ facilitator: FAC, cap: 1_000_000n, spent: 0n, validUntil: 2_000n, epoch: 1n }),
    recoverPayer: async () => PAYER,
    now: () => NOW_MS,
    ...over,
  };
}

const goodHeaders = { payer: PAYER, timestamp: '1000', signature: SIG };

describe('evaluateAccess', () => {
  it('allows a request with a valid proof and active grant', async () => {
    const res = await evaluateAccess(goodHeaders, deps(), cfg);
    expect(res).toEqual({ allow: true, payer: PAYER, vault: VAULT });
  });

  it('signs the expected proof message', () => {
    expect(proofMessage(PAYER, 1000)).toBe(`universal-paywall:${PAYER}:1000`);
  });

  it('402 payer_required when X-Payer is absent', async () => {
    const res = await evaluateAccess({}, deps(), cfg);
    expect(res.allow).toBe(false);
    if (!res.allow) {
      expect(res.status).toBe(402);
      expect((res.body as { error: string }).error).toBe('payer_required');
    }
  });

  it('401 when the payer proof is missing', async () => {
    const res = await evaluateAccess({ payer: PAYER }, deps(), cfg);
    expect(res).toMatchObject({ allow: false, status: 401 });
  });

  it('401 when the proof timestamp is outside the window', async () => {
    const res = await evaluateAccess({ ...goodHeaders, timestamp: '0' }, deps(), cfg);
    expect(res.allow).toBe(false);
    if (!res.allow) expect((res.body as { error: string }).error).toBe('proof_timestamp_out_of_window');
  });

  it('401 when the recovered signer != payer', async () => {
    const res = await evaluateAccess(goodHeaders, deps({ recoverPayer: async () => OTHER }), cfg);
    expect(res.allow).toBe(false);
    if (!res.allow) expect((res.body as { error: string }).error).toBe('invalid_payer_proof');
  });

  it('402 with a stake-scheme challenge when there is no grant', async () => {
    const res = await evaluateAccess(
      goodHeaders,
      deps({ readPolicy: async () => ({ facilitator: ZERO, cap: 0n, spent: 0n, validUntil: 0n, epoch: 0n }) }),
      cfg,
    );
    expect(res.allow).toBe(false);
    if (!res.allow) {
      expect(res.status).toBe(402);
      const body = res.body as { error: string; reason: string; accepts: Array<{ scheme: string }> };
      expect(body.error).toBe('payment_required');
      expect(body.reason).toBe('no_grant');
      expect(body.accepts[0]!.scheme).toBe('stake');
    }
  });

  it('402 when grant headroom is below the price', async () => {
    const res = await evaluateAccess(
      goodHeaders,
      deps({ readPolicy: async () => ({ facilitator: FAC, cap: 5_000n, spent: 0n, validUntil: 2_000n, epoch: 1n }) }),
      cfg,
    );
    expect(res.allow).toBe(false);
    if (!res.allow) {
      expect((res.body as { reason: string }).reason).toBe('insufficient_remaining');
    }
  });
});
