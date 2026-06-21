import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Hex } from '@universal-paywall/facilitator';
import { fastifyStakePaywall } from '../fastify.js';

// Chain config is required by the type but never reached on these paths:
// `evaluateAccess` short-circuits to 402/401 BEFORE any on-chain read when the
// payer header or signature is absent. So these assert the plugin wiring
// (preHandler runs and sends the gate's response) without needing a chain.
const opts = {
  price: 10_000n,
  creator: '0x2222222222222222222222222222222222222222' as Hex,
  chain: {
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337,
    network: 'eip155:31337',
    asset: '0x3600000000000000000000000000000000000000' as Hex,
    facilitatorAddress: '0xfac0000000000000000000000000000000000000' as Hex,
    stakeVaultFactory: '0xf00d000000000000000000000000000000000000' as Hex,
  },
  facilitator: { url: 'http://127.0.0.1:1', apiKey: 'k' },
};

async function build() {
  const app = Fastify();
  await app.register(fastifyStakePaywall(opts));
  app.get('/paid', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('fastifyStakePaywall', () => {
  it('returns 402 payer_required when X-Payer is absent', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/paid' });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('payer_required');
    await app.close();
  });

  it('returns 401 when the payer proof is missing', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/paid',
      headers: { 'x-payer': '0x1111111111111111111111111111111111111111' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
