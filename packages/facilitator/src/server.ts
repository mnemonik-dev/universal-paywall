import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { FacilitatorService } from './service.js';
import type { Hex } from './types.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^[0-9]+$/;
const MAX_BODY_BYTES = 16 * 1024;

export interface ServerOptions {
  apiKeys: ReadonlyArray<string>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isAddress(v: unknown): v is Hex {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

function authorized(req: IncomingMessage, keys: ReadonlySet<string>): boolean {
  const header = req.headers['x-api-key'];
  const key = Array.isArray(header) ? header[0] : header;
  return key !== undefined && keys.has(key);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Thin HTTP surface for the external facilitator:
 *   GET  /health  → liveness
 *   POST /charge  → record a metered charge (x-api-key auth)
 *   POST /flush   → force-settle all pending batches (x-api-key auth)
 */
export function createFacilitatorServer(service: FacilitatorService, opts: ServerOptions): Server {
  const keys = new Set(opts.apiKeys);

  return createServer((req, res) => {
    void handle(req, res, service, keys).catch((err: unknown) => {
      json(res, 400, { error: err instanceof Error ? err.message : 'bad_request' });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: FacilitatorService,
  keys: ReadonlySet<string>,
): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url === '/charge') {
    if (!authorized(req, keys)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!isAddress(body.payer) || !isAddress(body.creator)) {
      json(res, 400, { error: 'invalid_address' });
      return;
    }
    const amountRaw = typeof body.amount === 'number' ? String(body.amount) : body.amount;
    if (typeof amountRaw !== 'string' || !UINT_RE.test(amountRaw) || amountRaw === '0') {
      json(res, 400, { error: 'invalid_amount' });
      return;
    }
    const ref = typeof body.ref === 'string' ? body.ref : undefined;
    const record = service.charge({
      payer: body.payer,
      creator: body.creator,
      amount: BigInt(amountRaw),
      ...(ref !== undefined ? { ref } : {}),
    });
    json(res, 202, { id: record.id });
    return;
  }

  if (req.method === 'POST' && url === '/flush') {
    if (!authorized(req, keys)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const results = await service.flushAll();
    json(res, 200, {
      settled: results.length,
      results: results.map((r) => ({ ok: r.ok, txHash: r.txHash ?? null, reason: r.reason ?? null })),
    });
    return;
  }

  json(res, 404, { error: 'not_found' });
}
