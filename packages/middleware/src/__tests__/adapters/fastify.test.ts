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

  it('sets X-PAYMENT-RESPONSE header on passthrough; route handler runs and is the sole sender', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: 'passthrough',
      responseHeaders: { 'X-PAYMENT-RESPONSE': 'value' },
    });
    const app = Fastify();
    await app.register(fastifyPaywall(baseOpts));
    const routeHandlerCalls = vi.fn();
    app.get('/api', async () => {
      routeHandlerCalls();
      return { from: 'route' };
    });
    const res = await app.inject({ method: 'GET', url: '/api' });
    // The route handler must have run (proves the preHandler did NOT
    // short-circuit via reply.send) and the header set by the preHandler
    // must be present alongside the route's own body.
    expect(routeHandlerCalls).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ from: 'route' });
    expect(res.headers['x-payment-response']).toBe('value');
    await app.close();
  });

  it('handler exception propagates via Fastify error path (not swallowed by plugin)', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: 'passthrough',
      responseHeaders: { 'X-PAYMENT-RESPONSE': 'value' },
    });
    const app = Fastify();
    await app.register(fastifyPaywall(baseOpts));
    app.get('/api', async () => {
      throw new Error('handler-boom');
    });
    const res = await app.inject({ method: 'GET', url: '/api' });
    // Fastify's default error handler converts uncaught throws to 500.
    // If the plugin swallowed the exception we'd see 200 (or hang); a 500
    // proves Fastify's error path handled it instead of the plugin
    // suppressing it.
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
