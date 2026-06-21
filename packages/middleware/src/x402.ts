/**
 * x402 wire-format codec.
 *
 * Pure functions per tech-spec D1:
 *   - `build402Body(req, error?)` — pure object construction for the 402 challenge body.
 *   - `parseUsdPrice(input)` — USD decimal string → USDC base-unit (6 decimals) bigint.
 *   - `decodeXPayment(header)` — strict decode of the `X-PAYMENT` request header.
 *   - `encodeXPaymentResponse(...)` — encode the `X-PAYMENT-RESPONSE` settle reply.
 *
 * `parseUsdPrice` is called by `core.ts` BEFORE `build402Body`; `build402Body`
 * receives a pre-converted base-unit `maxAmountRequired` string (per addendum §11).
 */

import type { ExactEvmPayload, PaymentPayload, PaymentRequirements } from './types.js';

// ─── Errors ────────────────────────────────────────────────────────────────────

export class InvalidPriceError extends Error {
  readonly reason: 'invalid_price' | 'zero';
  constructor(reason: 'invalid_price' | 'zero', message?: string) {
    super(message ?? `parseUsdPrice: ${reason}`);
    this.name = 'InvalidPriceError';
    this.reason = reason;
  }
}

export interface MalformedHeaderDetail {
  phase: 'size' | 'base64' | 'json' | 'shape';
  path?: string;
  hint?: string;
}

export class MalformedPaymentHeaderError extends Error {
  readonly reason: 'header_too_large' | 'malformed_payment_header';
  readonly detail: MalformedHeaderDetail;
  constructor(
    reason: 'header_too_large' | 'malformed_payment_header',
    detail: MalformedHeaderDetail,
    message?: string,
  ) {
    super(message ?? `${reason}: ${detail.phase}${detail.path ? ' @' + detail.path : ''}`);
    this.name = 'MalformedPaymentHeaderError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ─── build402Body ──────────────────────────────────────────────────────────────

export type X402ChallengeBody = {
  x402Version: 1;
  accepts: PaymentRequirements[];
  error?: string;
};

export function build402Body(req: PaymentRequirements, error?: string): X402ChallengeBody {
  if (error !== undefined) {
    return { x402Version: 1, accepts: [req], error };
  }
  return { x402Version: 1, accepts: [req] };
}

// ─── parseUsdPrice ─────────────────────────────────────────────────────────────

const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;
const PRICE_RE = /^\d+(\.\d{1,6})?$/;

export function parseUsdPrice(input: string): bigint {
  if (typeof input !== 'string' || !PRICE_RE.test(input)) {
    throw new InvalidPriceError(
      'invalid_price',
      `parseUsdPrice: invalid_price (${JSON.stringify(input)})`,
    );
  }

  const dot = input.indexOf('.');
  let whole: string;
  let frac: string;
  if (dot === -1) {
    whole = input;
    frac = '';
  } else {
    whole = input.slice(0, dot);
    frac = input.slice(dot + 1);
  }
  const paddedFrac = (frac + '000000').slice(0, Number(USDC_DECIMALS));
  const result = BigInt(whole) * USDC_SCALE + BigInt(paddedFrac);

  if (result === 0n) {
    throw new InvalidPriceError('zero', 'parseUsdPrice: zero');
  }
  return result;
}

// ─── decodeXPayment ────────────────────────────────────────────────────────────

const MAX_HEADER_BYTES = 4096;
const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL_INT_RE = /^\d+$/;

const TOP_LEVEL_KEYS = ['x402Version', 'scheme', 'network', 'payload'] as const;
const PAYLOAD_KEYS = ['signature', 'authorization'] as const;
const AUTH_KEYS = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const;

function fail(phase: MalformedHeaderDetail['phase'], path: string, hint?: string): never {
  const reason = phase === 'size' ? 'header_too_large' : 'malformed_payment_header';
  const detail: MalformedHeaderDetail = { phase, path };
  if (hint !== undefined) detail.hint = hint;
  throw new MalformedPaymentHeaderError(reason, detail);
}

function assertExactKeys(obj: Record<string, unknown>, required: readonly string[], path: string) {
  const keys = Object.keys(obj);
  if (keys.length !== required.length) {
    fail('shape', path, `expected exactly ${required.length} keys`);
  }
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      fail('shape', `${path}.${k}`, 'missing required key');
    }
  }
  for (const k of keys) {
    if (!required.includes(k)) {
      fail('shape', `${path}.${k}`, 'unexpected key');
    }
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function decodeXPayment(header: string): PaymentPayload {
  if (typeof header !== 'string') {
    fail('size', '$', 'header must be a string');
  }
  const byteLen = Buffer.byteLength(header, 'utf8');
  if (byteLen > MAX_HEADER_BYTES) {
    throw new MalformedPaymentHeaderError('header_too_large', {
      phase: 'size',
      path: '$',
      hint: `header is ${byteLen} bytes; max ${MAX_HEADER_BYTES}`,
    });
  }

  let jsonText: string;
  try {
    jsonText = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    fail('base64', '$');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fail('json', '$');
  }

  if (!isPlainObject(parsed)) {
    fail('shape', '$', 'top-level must be an object');
  }
  assertExactKeys(parsed, TOP_LEVEL_KEYS, '$');

  if (parsed['x402Version'] !== 1) fail('shape', '$.x402Version', 'must be 1');
  if (parsed['scheme'] !== 'exact') fail('shape', '$.scheme', 'must be "exact"');
  if (typeof parsed['network'] !== 'string' || parsed['network'].length === 0) {
    fail('shape', '$.network', 'must be a non-empty string');
  }

  const payloadRaw = parsed['payload'];
  if (!isPlainObject(payloadRaw)) fail('shape', '$.payload', 'must be an object');
  assertExactKeys(payloadRaw, PAYLOAD_KEYS, '$.payload');

  if (typeof payloadRaw['signature'] !== 'string' || !HEX_SIG_RE.test(payloadRaw['signature'])) {
    fail('shape', '$.payload.signature', 'must be 0x + 130 hex chars');
  }

  const authRaw = payloadRaw['authorization'];
  if (!isPlainObject(authRaw)) fail('shape', '$.payload.authorization', 'must be an object');
  assertExactKeys(authRaw, AUTH_KEYS, '$.payload.authorization');

  if (typeof authRaw['from'] !== 'string' || !HEX_ADDR_RE.test(authRaw['from'])) {
    fail('shape', '$.payload.authorization.from', 'must be a 20-byte 0x-hex address');
  }
  if (typeof authRaw['to'] !== 'string' || !HEX_ADDR_RE.test(authRaw['to'])) {
    fail('shape', '$.payload.authorization.to', 'must be a 20-byte 0x-hex address');
  }
  if (typeof authRaw['value'] !== 'string' || !DECIMAL_INT_RE.test(authRaw['value'])) {
    fail('shape', '$.payload.authorization.value', 'must be a decimal-integer string');
  }
  if (typeof authRaw['validAfter'] !== 'string' || !DECIMAL_INT_RE.test(authRaw['validAfter'])) {
    fail('shape', '$.payload.authorization.validAfter', 'must be a decimal-integer string');
  }
  if (typeof authRaw['validBefore'] !== 'string' || !DECIMAL_INT_RE.test(authRaw['validBefore'])) {
    fail('shape', '$.payload.authorization.validBefore', 'must be a decimal-integer string');
  }
  if (typeof authRaw['nonce'] !== 'string' || !HEX_32_RE.test(authRaw['nonce'])) {
    fail('shape', '$.payload.authorization.nonce', 'must be 0x + 64 hex chars');
  }

  const authorization: ExactEvmPayload['authorization'] = {
    from: authRaw['from'] as `0x${string}`,
    to: authRaw['to'] as `0x${string}`,
    value: authRaw['value'],
    validAfter: authRaw['validAfter'],
    validBefore: authRaw['validBefore'],
    nonce: authRaw['nonce'] as `0x${string}`,
  };
  const payload: ExactEvmPayload = {
    signature: payloadRaw['signature'] as `0x${string}`,
    authorization,
  };
  return {
    x402Version: 1,
    scheme: 'exact',
    network: parsed['network'],
    payload,
  };
}

// ─── encodeXPaymentResponse ────────────────────────────────────────────────────

export interface XPaymentResponse {
  success: boolean;
  transaction: `0x${string}`;
  network: string;
  payer: `0x${string}`;
}

export function encodeXPaymentResponse(input: XPaymentResponse): string {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
}
