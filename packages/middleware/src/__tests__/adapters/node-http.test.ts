import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Mock the core module so we can drive the adapter through both branches
// without exercising the real pipeline.
const paywallMock = vi.fn();

vi.mock('../../core.js', () => ({
  paywall: (...args: unknown[]) => paywallMock(...args),
}));

const { withPaywall } = await import('../../adapters/node-http.js');

const baseOpts = {} as Parameters<typeof withPaywall>[1];

function makeReq(headers: Record<string, string | string[]>, method = 'GET', url = '/api') {
  return { headers, method, url } as unknown as IncomingMessage;
}

function makeRes() {
  const setHeaderCalls: Array<[string, string]> = [];
  const writeHeadCalls: Array<[number, Record<string, string>]> = [];
  let endBody: string | undefined;
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      setHeaderCalls.push([name, value]);
    }),
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      writeHeadCalls.push([status, headers]);
    }),
    end: vi.fn((body?: string) => {
      endBody = body;
    }),
  } as unknown as ServerResponse;
  return { res, getEndBody: () => endBody, setHeaderCalls, writeHeadCalls };
}

beforeEach(() => {
  paywallMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('withPaywall — Node http adapter', () => {
  it('writes 402 body + Content-Type application/json when paywall returns 402', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: '402',
      status: 402,
      headers: { 'Content-Type': 'application/json' },
      body: { x402Version: 1, accepts: [], error: 'payment_required' },
    });
    const handler = vi.fn();
    const wrapped = withPaywall(handler, baseOpts);
    const req = makeReq({ host: 'example.com' });
    const { res, getEndBody, writeHeadCalls } = makeRes();
    await wrapped(req, res);
    expect(handler).not.toHaveBeenCalled();
    expect(writeHeadCalls).toHaveLength(1);
    expect(writeHeadCalls[0]![0]).toBe(402);
    expect(writeHeadCalls[0]![1]['Content-Type']).toBe('application/json');
    const body = JSON.parse(getEndBody() ?? '');
    expect(body).toEqual({ x402Version: 1, accepts: [], error: 'payment_required' });
  });

  it('writes 400 body when paywall returns 400 status', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: '402',
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: { x402Version: 1, accepts: [], error: 'malformed_payment_header' },
    });
    const wrapped = withPaywall(vi.fn(), baseOpts);
    const req = makeReq({});
    const { res, writeHeadCalls } = makeRes();
    await wrapped(req, res);
    expect(writeHeadCalls[0]![0]).toBe(400);
  });

  it('sets X-PAYMENT-RESPONSE header before invoking user handler on passthrough', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: 'passthrough',
      responseHeaders: { 'X-PAYMENT-RESPONSE': 'xxx-base64-xxx' },
    });
    // Capture the order: setHeader must fire BEFORE handler is called.
    const callOrder: string[] = [];
    const req = makeReq({ 'x-payment': 'value' });
    const { res, setHeaderCalls } = makeRes();
    const origSetHeader = res.setHeader;
    (res as unknown as { setHeader: typeof origSetHeader }).setHeader = vi.fn(
      (name: string, value: string) => {
        callOrder.push('setHeader:' + name);
        origSetHeader.call(res, name, value);
      },
    );
    const handler = vi.fn(async () => {
      callOrder.push('handler');
    });
    const wrapped = withPaywall(handler, baseOpts);
    await wrapped(req, res);
    expect(callOrder).toEqual(['setHeader:X-PAYMENT-RESPONSE', 'handler']);
    expect(setHeaderCalls).toContainEqual(['X-PAYMENT-RESPONSE', 'xxx-base64-xxx']);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it('propagates handler exceptions unchanged', async () => {
    paywallMock.mockResolvedValueOnce({
      kind: 'passthrough',
      responseHeaders: { 'X-PAYMENT-RESPONSE': 'xx' },
    });
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = withPaywall(handler, baseOpts);
    const req = makeReq({});
    const { res } = makeRes();
    await expect(wrapped(req, res)).rejects.toThrow('boom');
  });
});
