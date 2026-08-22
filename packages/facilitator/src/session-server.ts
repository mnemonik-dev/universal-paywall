import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PaymentServiceError, SessionPaymentService } from './session-service.js';
import type { OperationBinding, RegisterSessionRequest, SettleRequest } from './session-types.js';
import type { X402Facilitator } from './x402-http.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface SessionServerOptions {
  apiKeys: ReadonlyArray<string>;
  /**
   * x402 v1 facilitator API (U1). When provided, three spec routes are
   * served alongside the /v1/* API: GET /supported (public — discovery must
   * precede credentials, per the U1 decision), and POST /verify +
   * POST /settle behind the same x-api-key gate as /v1/*.
   */
  x402?: X402Facilitator;
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
  if (key === undefined) return false;
  // Constant-time comparison over digests: the gate now fronts a money
  // endpoint, so a byte-by-byte string compare's timing must not leak key
  // prefixes. Hashing first equalizes lengths for timingSafeEqual.
  const candidate = createHash('sha256').update(key).digest();
  let matched = false;
  for (const known of keys) {
    if (timingSafeEqual(candidate, createHash('sha256').update(known).digest())) {
      matched = true;
    }
  }
  return matched;
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
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PaymentServiceError('invalid_path_segment', 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** Stable HTTP-only integration boundary for non-TypeScript services. */
export function createSessionPaymentServer(
  service: SessionPaymentService,
  opts: SessionServerOptions,
): Server {
  const keys = new Set(opts.apiKeys);
  return createServer((req, res) => {
    void handle(req, res, service, keys, opts.x402).catch((error: unknown) => {
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
  x402?: X402Facilitator,
): Promise<void> {
  setCorsHeaders(res);
  const url = new URL(req.url ?? '/', 'http://universal-paywall.local');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, api: 'session-payments-v1' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/payment-receipt-key') {
    json(res, 200, service.receiptKey());
    return;
  }
  if (x402 !== undefined && req.method === 'GET' && url.pathname === '/supported') {
    json(res, 200, x402.supported());
    return;
  }
  if (!authorized(req, keys)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (x402 !== undefined && req.method === 'POST' && url.pathname === '/verify') {
    json(res, 200, await x402.verify(await readBody(req)));
    return;
  }
  if (x402 !== undefined && req.method === 'POST' && url.pathname === '/settle') {
    json(res, 200, await x402.settle(await readBody(req)));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/v1/quotes/')) {
    const id = segment(url, 2);
    if (id === undefined || id.length === 0) throw new PaymentServiceError('quote_not_found', 404);
    json(res, 200, await service.getQuoteByOperationId(id));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/quotes') {
    const body = await readBody(req);
    if (!isRecord(body) || !isRecord(body['binding'])) {
      throw new PaymentServiceError('missing_binding', 400);
    }
    json(res, 201, await service.createQuote(body['binding'] as unknown as OperationBinding));
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
