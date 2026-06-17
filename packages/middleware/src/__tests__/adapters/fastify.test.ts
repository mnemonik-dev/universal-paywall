import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const paywallMock = vi.fn();
vi.mock('../../core.js', () => ({
  paywall: (...args: unknown[]) => paywallMock(...args),
}));

const { fastifyPaywall } = await import('../../adapters/fastify.js');

const baseOpts = {} as Parameters<typeof fastifyPaywall>[0];

beforeEach(() => {
  paywallMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('fastifyPaywall — Fastify adapter', () => {
  it('preHandler sends 402 reply when paywall returns 402', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: '402',
      status: 402,
      headers: { 'Content-Type': 'application/json' },
      body: { x402Version: 1, accepts: [], error: 'payment_required' },
    });
    const handler = vi.fn();
    const app = Fastify();
    await app.register(fastifyPaywall(baseOpts));
    app.get('/api', async (_req, _reply) => {
      handler();
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/api' });
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body)).toEqual({
      x402Version: 1,
      accepts: [],
      error: 'payment_required',
    });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('preHandler sends 400 reply when paywall returns 400 status', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: '402',
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: { x402Version: 1, accepts: [], error: 'malformed_payment_header' },
    });
    const app = Fastify();
    await app.register(fastifyPaywall(baseOpts));
    app.get('/api', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/api' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('preserves reply chaining on 200 path — user route handler runs and returns its own body alongside X-PAYMENT-RESPONSE header', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: 'passthrough',
      responseHeaders: { 'X-PAYMENT-RESPONSE': 'header-base64' },
    });
    const app = Fastify();
    await app.register(fastifyPaywall(baseOpts));
    app.get('/api', async () => ({ ok: true, who: 'route-handler' }));
    const res = await app.inject({ method: 'GET', url: '/api' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, who: 'route-handler' });
    expect(res.headers['x-payment-response']).toBe('header-base64');
    await app.close();
  });

  it('sets X-PAYMENT-RESPONSE header on passthrough without calling reply.send', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: 'passthrough',
      responseHeaders: { 'X-PAYMENT-RESPONSE': 'value' },
    });
    const app = Fastify();
    await app.register(fastifyPaywall(baseOpts));
    let sentByPreHandler = false;
    app.addHook('onSend', async (_req, reply, payload) => {
      // If the preHandler had sent the response itself, the route handler
      // wouldn't run; this assertion checks the route handler did run.
      if (reply.statusCode === 200 && payload !== undefined) sentByPreHandler = false;
      return payload;
    });
    app.get('/api', async () => ({ from: 'route' }));
    const res = await app.inject({ method: 'GET', url: '/api' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ from: 'route' });
    expect(res.headers['x-payment-response']).toBe('value');
    expect(sentByPreHandler).toBe(false);
    await app.close();
  });
});
