import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PaymentServiceError, SessionPaymentService } from './session-service.js';
import type { OperationBinding, RegisterSessionRequest, SettleRequest } from './session-types.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface SessionServerOptions {
  apiKeys: ReadonlyArray<string>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, keys: ReadonlySet<string>): boolean {
  const header = req.headers['x-api-key'];
  const key = Array.isArray(header) ? header[0] : header;
  return key !== undefined && keys.has(key);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PaymentServiceError('body_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new PaymentServiceError('invalid_json', 400));
      }
    });
    req.on('error', reject);
  });
}

function segment(url: URL, index: number): string | undefined {
  const value = url.pathname.split('/').filter(Boolean)[index];
  return value === undefined ? undefined : decodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable HTTP-only integration boundary for non-TypeScript services. */
export function createSessionPaymentServer(
  service: SessionPaymentService,
  opts: SessionServerOptions,
): Server {
  const keys = new Set(opts.apiKeys);
  return createServer((req, res) => {
    void handle(req, res, service, keys).catch((error: unknown) => {
      if (error instanceof PaymentServiceError) {
        json(res, error.status, { error: error.code });
        return;
      }
      json(res, 500, { error: 'internal_error' });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: SessionPaymentService,
  keys: ReadonlySet<string>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://universal-paywall.local');
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, api: 'session-payments-v1' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/payment-receipt-key') {
    json(res, 200, service.receiptKey());
    return;
  }
  if (!authorized(req, keys)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/quotes') {
    const body = await readBody(req);
    if (!isRecord(body) || !isRecord(body['binding'])) {
      throw new PaymentServiceError('missing_binding', 400);
    }
    json(res, 201, service.createQuote(body['binding'] as unknown as OperationBinding));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/sessions') {
    const body = await readBody(req);
    if (
      !isRecord(body) ||
      !isRecord(body['authorization']) ||
      typeof body['signature'] !== 'string'
    ) {
      throw new PaymentServiceError('invalid_session_request', 400);
    }
    json(res, 201, await service.registerSession(body as unknown as RegisterSessionRequest));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/v1/sessions/')) {
    const id = segment(url, 2);
    if (id === undefined || id.length === 0)
      throw new PaymentServiceError('session_not_found', 404);
    json(res, 200, await service.getSession(id));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/payments/settle') {
    const body = await readBody(req);
    if (!isRecord(body) || !isRecord(body['binding']) || !isRecord(body['payment'])) {
      throw new PaymentServiceError('invalid_settle_request', 400);
    }
    json(res, 200, await service.settle(body as unknown as SettleRequest));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/v1/payments/')) {
    const id = segment(url, 2);
    if (id === undefined || id.length === 0)
      throw new PaymentServiceError('payment_not_found', 404);
    json(res, 200, await service.getPaymentStatus(id));
    return;
  }
  json(res, 404, { error: 'not_found' });
}
