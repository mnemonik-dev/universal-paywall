import { describe, expect, it } from 'vitest';
import {
  InvalidPriceError,
  MalformedPaymentHeaderError,
  build402Body,
  decodeXPayment,
  encodeXPaymentResponse,
  parseUsdPrice,
} from '../x402.js';
import type { PaymentPayload, PaymentRequirements } from '../types.js';

const ZERO_ADDR: `0x${string}` = '0x0000000000000000000000000000000000000000';
const SAMPLE_FROM: `0x${string}` = '0x1111111111111111111111111111111111111111';
const SAMPLE_TO: `0x${string}` = '0x2222222222222222222222222222222222222222';
const SAMPLE_NONCE: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SAMPLE_SIG: `0x${string}` = ('0x' + 'cd'.repeat(65)) as `0x${string}`;

const sampleRequirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:5042002',
  maxAmountRequired: '10000',
  resource: 'https://example.com/api',
  description: 'sample',
  mimeType: 'application/json',
  payTo: ZERO_ADDR,
  maxTimeoutSeconds: 60,
  asset: ZERO_ADDR,
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
};

const sampleAuthorization = {
  from: SAMPLE_FROM,
  to: SAMPLE_TO,
  value: '10000',
  validAfter: '0',
  validBefore: '9999999999',
  nonce: SAMPLE_NONCE,
} as const;

const samplePayload: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'eip155:5042002',
  payload: {
    signature: SAMPLE_SIG,
    authorization: sampleAuthorization,
  },
};

function encodeHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

describe('build402Body', () => {
  it('returns spec-compliant accepts array', () => {
    const body = build402Body(sampleRequirements);
    expect(body).toEqual({ x402Version: 1, accepts: [sampleRequirements] });
  });

  it('includes error field when provided', () => {
    const body = build402Body(sampleRequirements, 'payment_required');
    expect(body).toEqual({
      x402Version: 1,
      accepts: [sampleRequirements],
      error: 'payment_required',
    });
  });

  it('omits error field when not provided (does not set undefined)', () => {
    const body = build402Body(sampleRequirements);
    expect('error' in body).toBe(false);
  });
});

describe('parseUsdPrice', () => {
  it('converts decimal string to 6-decimal bigint', () => {
    expect(parseUsdPrice('0.01')).toBe(10000n);
    expect(parseUsdPrice('1')).toBe(1_000_000n);
    expect(parseUsdPrice('1.000001')).toBe(1_000_001n);
    expect(parseUsdPrice('1.5')).toBe(1_500_000n);
    expect(parseUsdPrice('123.456789')).toBe(123_456_789n);
  });

  it('rejects zero', () => {
    for (const input of ['0', '0.0', '0.000000']) {
      expect(() => parseUsdPrice(input)).toThrow(InvalidPriceError);
      try {
        parseUsdPrice(input);
      } catch (e) {
        expect((e as InvalidPriceError).reason).toBe('zero');
      }
    }
  });

  it('rejects more than 6 decimals', () => {
    expect(() => parseUsdPrice('0.0000001')).toThrow(InvalidPriceError);
    expect(() => parseUsdPrice('1.1234567')).toThrow(InvalidPriceError);
  });

  it('rejects non-numeric input', () => {
    for (const input of ['abc', '', '-1', '-0.01', '.5', 'NaN']) {
      expect(() => parseUsdPrice(input)).toThrow(InvalidPriceError);
    }
  });

  it('rejects scientific notation', () => {
    for (const input of ['1e2', '1E2', '1.5e3', '2e-3']) {
      expect(() => parseUsdPrice(input)).toThrow(InvalidPriceError);
    }
  });

  it('rejects whitespace', () => {
    for (const input of [' 1', '1 ', ' 1.00 ', '\t1']) {
      expect(() => parseUsdPrice(input)).toThrow(InvalidPriceError);
    }
  });
});

describe('decodeXPayment', () => {
  it('round-trips a valid header', () => {
    const decoded = decodeXPayment(encodeHeader(samplePayload));
    expect(decoded).toEqual(samplePayload);
  });

  it('rejects header > 4096 bytes', () => {
    const oversize = 'A'.repeat(5000);
    try {
      decodeXPayment(oversize);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedPaymentHeaderError);
      expect((e as MalformedPaymentHeaderError).reason).toBe('header_too_large');
    }
  });

  it('rejects extra keys in payload', () => {
    const bad = {
      ...samplePayload,
      payload: {
        ...samplePayload.payload,
        developerId: 'extra',
      },
    };
    try {
      decodeXPayment(encodeHeader(bad));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedPaymentHeaderError);
      expect((e as MalformedPaymentHeaderError).reason).toBe('malformed_payment_header');
      expect((e as MalformedPaymentHeaderError).detail).toEqual(
        expect.objectContaining({ phase: 'shape' }),
      );
    }
  });

  it('rejects extra keys at the top level', () => {
    const bad = { ...samplePayload, somethingElse: true };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects extra keys in authorization', () => {
    const bad = {
      ...samplePayload,
      payload: {
        ...samplePayload.payload,
        authorization: { ...samplePayload.payload.authorization, extra: 1 },
      },
    };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it.each([
    ['x402Version', { ...samplePayload, x402Version: undefined as unknown }],
    ['scheme', { ...samplePayload, scheme: undefined as unknown }],
    ['network', { ...samplePayload, network: undefined as unknown }],
    [
      'payload.signature',
      { ...samplePayload, payload: { ...samplePayload.payload, signature: undefined } },
    ],
    [
      'payload.authorization.from',
      {
        ...samplePayload,
        payload: {
          ...samplePayload.payload,
          authorization: { ...sampleAuthorization, from: undefined },
        },
      },
    ],
    [
      'payload.authorization.to',
      {
        ...samplePayload,
        payload: {
          ...samplePayload.payload,
          authorization: { ...sampleAuthorization, to: undefined },
        },
      },
    ],
    [
      'payload.authorization.value',
      {
        ...samplePayload,
        payload: {
          ...samplePayload.payload,
          authorization: { ...sampleAuthorization, value: undefined },
        },
      },
    ],
    [
      'payload.authorization.validAfter',
      {
        ...samplePayload,
        payload: {
          ...samplePayload.payload,
          authorization: { ...sampleAuthorization, validAfter: undefined },
        },
      },
    ],
    [
      'payload.authorization.validBefore',
      {
        ...samplePayload,
        payload: {
          ...samplePayload.payload,
          authorization: { ...sampleAuthorization, validBefore: undefined },
        },
      },
    ],
    [
      'payload.authorization.nonce',
      {
        ...samplePayload,
        payload: {
          ...samplePayload.payload,
          authorization: { ...sampleAuthorization, nonce: undefined },
        },
      },
    ],
  ])('rejects missing required leaf: %s', (_leafName, bad) => {
    const cleaned = JSON.parse(JSON.stringify(bad));
    expect(() => decodeXPayment(encodeHeader(cleaned))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects invalid hex shapes — signature too short', () => {
    const bad = {
      ...samplePayload,
      payload: { ...samplePayload.payload, signature: '0x12' },
    };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects invalid hex shapes — nonce wrong length', () => {
    const bad = {
      ...samplePayload,
      payload: {
        ...samplePayload.payload,
        authorization: { ...sampleAuthorization, nonce: '0xabcd' },
      },
    };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects invalid hex shapes — from not 20 bytes', () => {
    const bad = {
      ...samplePayload,
      payload: {
        ...samplePayload.payload,
        authorization: { ...sampleAuthorization, from: '0x1234' },
      },
    };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects malformed JSON', () => {
    const bad = Buffer.from('not-valid-json', 'utf8').toString('base64');
    try {
      decodeXPayment(bad);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedPaymentHeaderError);
      expect((e as MalformedPaymentHeaderError).reason).toBe('malformed_payment_header');
      expect((e as MalformedPaymentHeaderError).detail).toEqual(
        expect.objectContaining({ phase: 'json' }),
      );
    }
  });

  it('rejects empty header', () => {
    expect(() => decodeXPayment('')).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects JSON that is not an object', () => {
    const bad = Buffer.from('42', 'utf8').toString('base64');
    expect(() => decodeXPayment(bad)).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects x402Version other than 1', () => {
    const bad = { ...samplePayload, x402Version: 2 };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects scheme other than "exact"', () => {
    const bad = { ...samplePayload, scheme: 'lazy' };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });

  it('rejects non-decimal value', () => {
    const bad = {
      ...samplePayload,
      payload: {
        ...samplePayload.payload,
        authorization: { ...sampleAuthorization, value: '1.5' },
      },
    };
    expect(() => decodeXPayment(encodeHeader(bad))).toThrow(MalformedPaymentHeaderError);
  });
});

describe('encodeXPaymentResponse', () => {
  it('round-trips through base64+JSON', () => {
    const input = {
      success: true,
      transaction: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      network: 'eip155:5042002',
      payer: SAMPLE_FROM,
    };
    const encoded = encodeXPaymentResponse(input);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(decoded).toEqual(input);
  });
});
