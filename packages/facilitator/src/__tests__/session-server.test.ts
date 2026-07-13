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
