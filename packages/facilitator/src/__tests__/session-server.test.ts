import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionPaymentServer } from '../session-server.js';
import { PaymentServiceError, type SessionPaymentService } from '../session-service.js';

describe('session payment HTTP API', () => {
  const receipt = {
    operation_id: 'op-1',
    scheme: 'stake',
    status: 'settled',
    settlement_tx: `0x${'11'.repeat(32)}`,
    settled_at: '2026-07-13T12:00:00.000Z',
    receipt: { signature: { algorithm: 'Ed25519', key_id: 'key-1', value: 'signed' } },
  };
  const fake = {
    receiptKey: vi.fn(() => ({ key_id: 'key-1', algorithm: 'Ed25519', public_key_pem: 'pem' })),
    createQuote: vi.fn((binding: unknown) => ({ quote_id: 'q_1', binding })),
    registerSession: vi.fn(async () => ({ session_id: 'session-1', status: 'active' })),
    getSession: vi.fn(async (id: string) => ({ session_id: id, status: 'active' })),
    settle: vi.fn(async () => receipt),
    getPaymentStatus: vi.fn((id: string) => ({ operation_id: id, status: 'settled', receipt })),
    getQuoteByOperationId: vi.fn((id: string) => ({
      quote_id: 'q_1',
      binding: { operation_id: id },
      binding_digest: `0x${'22'.repeat(32)}`,
      accepts: [{ scheme: 'exact' }],
    })),
  };

  beforeEach(() => vi.clearAllMocks());

  async function inject(
    method: string,
    url: string,
    body?: unknown,
    apiKey?: string,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const server = createSessionPaymentServer(fake as unknown as SessionPaymentService, {
      apiKeys: ['secret'],
    });
    const listener = server.listeners('request')[0] as (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void;
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(encoded === '' ? [] : [Buffer.from(encoded)]) as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }),
    };
    return new Promise((resolve) => {
      let status = 200;
      let headers: Record<string, string> = {};
      const res = {
        setHeader(_name: string, _value: string) {
          return this;
        },
        writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
          status = nextStatus;
          headers = nextHeaders;
          return this;
        },
        end(chunk?: string) {
          resolve({
            status,
            body: chunk === undefined || chunk === '' ? undefined : JSON.parse(chunk),
            headers,
          });
          return this;
        },
      } as unknown as ServerResponse;
      listener(req, res);
    });
  }

  it('exposes public health and receipt-key discovery', async () => {
    await expect(inject('GET', '/health')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, api: 'session-payments-v1' },
    });
    await expect(inject('GET', '/.well-known/payment-receipt-key')).resolves.toMatchObject({
      status: 200,
      body: { key_id: 'key-1', algorithm: 'Ed25519' },
    });
  });

  it('requires the scoped service key and routes synchronous settlement', async () => {
    await expect(inject('POST', '/v1/payments/settle', {})).resolves.toMatchObject({
      status: 401,
      body: { error: 'unauthorized' },
    });
    await expect(
      inject('POST', '/v1/payments/settle', { binding: {}, payment: {} }, 'secret'),
    ).resolves.toMatchObject({ status: 200, body: { operation_id: 'op-1', status: 'settled' } });
    expect(fake.settle).toHaveBeenCalledTimes(1);
  });

  it('returns a quote by operation id', async () => {
    await expect(inject('GET', '/v1/quotes/op-1', undefined, 'secret')).resolves.toMatchObject({
      status: 200,
      body: { quote_id: 'q_1', accepts: [{ scheme: 'exact' }] },
    });
    expect(fake.getQuoteByOperationId).toHaveBeenCalledWith('op-1');
  });

  it('decodes status identifiers and preserves typed service errors', async () => {
    await expect(
      inject('GET', '/v1/payments/op%20with%20spaces', undefined, 'secret'),
    ).resolves.toMatchObject({
      status: 200,
    });
    expect(fake.getPaymentStatus).toHaveBeenCalledWith('op with spaces');

    fake.getSession.mockRejectedValueOnce(new PaymentServiceError('session_not_found', 404));
    await expect(inject('GET', '/v1/sessions/missing', undefined, 'secret')).resolves.toEqual({
      status: 404,
      body: { error: 'session_not_found' },
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  });
});

describe('x402 facilitator routes (U1)', () => {
  const fakeService = {
    receiptKey: vi.fn(() => ({ key_id: 'key-1', algorithm: 'Ed25519', public_key_pem: 'pem' })),
  };
  const fakeX402 = {
    supported: vi.fn(() => ({
      kinds: [{ x402Version: 1, scheme: 'exact', network: 'eip155:1' }],
      signers: {},
    })),
    verify: vi.fn(async () => ({
      isValid: true,
      payer: '0x1111111111111111111111111111111111111111',
    })),
    settle: vi.fn(async () => ({
      success: true,
      payer: '0x1111111111111111111111111111111111111111',
      transaction: `0x${'ab'.repeat(32)}`,
      network: 'eip155:1',
    })),
  };

  beforeEach(() => vi.clearAllMocks());

  async function inject(
    method: string,
    url: string,
    body?: unknown,
    apiKey?: string,
    withX402 = true,
  ): Promise<{ status: number; body: unknown }> {
    const server = createSessionPaymentServer(fakeService as unknown as SessionPaymentService, {
      apiKeys: ['secret'],
      ...(withX402
        ? { x402: fakeX402 as unknown as import('../x402-http.js').X402Facilitator }
        : {}),
    });
    const listener = server.listeners('request')[0] as (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void;
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(encoded === '' ? [] : [Buffer.from(encoded)]) as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = apiKey === undefined ? {} : { 'x-api-key': apiKey };
    return new Promise((resolve) => {
      let status = 200;
      const res = {
        setHeader() {
          return this;
        },
        writeHead(nextStatus: number) {
          status = nextStatus;
          return this;
        },
        end(chunk?: string) {
          resolve({ status, body: chunk ? JSON.parse(chunk) : undefined });
          return this;
        },
      } as unknown as ServerResponse;
      listener(req, res);
    });
  }

  it('GET /supported is public — no api key required', async () => {
    await expect(inject('GET', '/supported')).resolves.toMatchObject({
      status: 200,
      body: { kinds: [{ x402Version: 1, scheme: 'exact', network: 'eip155:1' }] },
    });
    expect(fakeX402.supported).toHaveBeenCalledTimes(1);
  });

  it('POST /verify requires the api key and forwards the parsed body', async () => {
    await expect(inject('POST', '/verify', { x402Version: 1 })).resolves.toMatchObject({
      status: 401,
    });
    await expect(inject('POST', '/verify', { x402Version: 1 }, 'secret')).resolves.toMatchObject({
      status: 200,
      body: { isValid: true },
    });
    expect(fakeX402.verify).toHaveBeenCalledWith({ x402Version: 1 });
  });

  it('POST /settle requires the api key and returns the settlement response', async () => {
    await expect(inject('POST', '/settle', { x402Version: 1 })).resolves.toMatchObject({
      status: 401,
    });
    await expect(inject('POST', '/settle', { x402Version: 1 }, 'secret')).resolves.toMatchObject({
      status: 200,
      body: { success: true, network: 'eip155:1' },
    });
    expect(fakeX402.settle).toHaveBeenCalledTimes(1);
  });

  it('without the x402 option the routes stay unrouted', async () => {
    await expect(inject('GET', '/supported', undefined, undefined, false)).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      inject('POST', '/verify', { x402Version: 1 }, 'secret', false),
    ).resolves.toMatchObject({ status: 404 });
  });
});

describe('api-key gate — multi-key constant-time comparison', () => {
  const fakeService = {
    receiptKey: vi.fn(() => ({ key_id: 'key-1', algorithm: 'Ed25519', public_key_pem: 'pem' })),
    getPaymentStatus: vi.fn((id: string) => ({ operation_id: id, status: 'settled' })),
  };

  async function probe(apiKey: string | undefined): Promise<number> {
    const server = createSessionPaymentServer(fakeService as unknown as SessionPaymentService, {
      apiKeys: ['first-key', 'second-key'],
    });
    const listener = server.listeners('request')[0] as (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void;
    const req = Readable.from([]) as IncomingMessage;
    req.method = 'GET';
    req.url = '/v1/payments/op-1';
    req.headers = apiKey === undefined ? {} : { 'x-api-key': apiKey };
    return new Promise((resolve) => {
      let status = 200;
      const res = {
        setHeader() {
          return this;
        },
        writeHead(nextStatus: number) {
          status = nextStatus;
          return this;
        },
        end() {
          resolve(status);
          return this;
        },
      } as unknown as ServerResponse;
      listener(req, res);
    });
  }

  it('any configured key matches, unknown and missing keys do not', async () => {
    await expect(probe('first-key')).resolves.toBe(200);
    await expect(probe('second-key')).resolves.toBe(200);
    await expect(probe('wrong-key')).resolves.toBe(401);
    await expect(probe(undefined)).resolves.toBe(401);
  });
});
