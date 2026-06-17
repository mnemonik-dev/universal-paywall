import type { PaymentPayload } from '../../types.js';

const ZERO: `0x${string}` = '0x0000000000000000000000000000000000000000';
const ONES_FROM: `0x${string}` = '0x1111111111111111111111111111111111111111';
const TWOS_TO: `0x${string}` = '0x2222222222222222222222222222222222222222';
const SAMPLE_NONCE: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SAMPLE_SIG: `0x${string}` = ('0x' + 'cd'.repeat(65)) as `0x${string}`;

export const SAMPLE_VALID_PAYLOAD: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'eip155:5042002',
  payload: {
    signature: SAMPLE_SIG,
    authorization: {
      from: ONES_FROM,
      to: TWOS_TO,
      value: '10000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: SAMPLE_NONCE,
    },
  },
};

export function encodeValidHeader(payload: PaymentPayload = SAMPLE_VALID_PAYLOAD): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Construct a header that exceeds the 4 KB cap. Returns a string of `size`
 * ASCII characters ('A' — incidentally a valid base64 character, but
 * irrelevant here). `decodeXPayment` measures the raw header byte length
 * before any base64 decoding, so any string longer than 4096 bytes trips
 * the size guard regardless of base64 validity.
 */
export function oversizedHeader(size = 5000): string {
  return 'A'.repeat(size);
}

/**
 * Produce a base64 header whose decoded payload is not valid UTF-8 / not
 * valid JSON.
 */
export function malformedJsonHeader(): string {
  return Buffer.from('not-valid-json', 'utf8').toString('base64');
}

/**
 * Produce a base64 header whose decoded payload is a JSON object with the
 * wrong shape (extra key).
 */
export function malformedShapeHeader(): string {
  return Buffer.from(JSON.stringify({ unknown: 'shape' }), 'utf8').toString('base64');
}

export const FIXTURE_ADDRESSES = {
  ZERO,
  FROM: ONES_FROM,
  TO: TWOS_TO,
  NONCE: SAMPLE_NONCE,
  SIGNATURE: SAMPLE_SIG,
} as const;
