import { describe, expect, it } from 'vitest';
import {
  type ErrorReason,
  type SettlementSubReason,
  buildErrorResponse,
  MalformedPaymentHeaderError,
} from '../errors.js';
import type { PaymentRequirements } from '../types.js';

const ZERO_ADDR: `0x${string}` = '0x0000000000000000000000000000000000000000';

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

const FOUR_HUNDRED: ErrorReason[] = ['header_too_large', 'malformed_payment_header'];
const FOUR_HUNDRED_TWO: ErrorReason[] = [
  'payment_required',
  'invalid_signature',
  'insufficient_amount',
  'authorization_expired',
  'authorization_not_yet_valid',
  'nonce_already_used',
  'network_mismatch',
  'paused',
  'vault_not_deployed',
  'to_mismatch',
  'settlement_failed',
];

const SETTLEMENT_SUB_REASONS: SettlementSubReason[] = [
  'rpc_timeout',
  'rpc_5xx',
  'gas_estimate_revert',
  'mine_timeout',
  'receipt_reverted',
  'relayer_no_balance',
  'authorization_already_used_onchain',
];

describe('buildErrorResponse', () => {
  it.each(FOUR_HUNDRED)('maps 400-set reason %s to status 400', (reason) => {
    const r = buildErrorResponse(reason, { accepts: [sampleRequirements] });
    expect(r.status).toBe(400);
  });

  it.each(FOUR_HUNDRED_TWO)('maps 402-set reason %s to status 402', (reason) => {
    const r = buildErrorResponse(reason, { accepts: [sampleRequirements] });
    expect(r.status).toBe(402);
  });

  it.each(SETTLEMENT_SUB_REASONS)(
    'settlement_failed with sub-reason %s yields status 402 and includes settlementReason',
    (sub) => {
      const r = buildErrorResponse('settlement_failed', {
        accepts: [sampleRequirements],
        settlementReason: sub,
      });
      expect(r.status).toBe(402);
      expect((r.body as { settlementReason?: string }).settlementReason).toBe(sub);
    },
  );

  it('body matches x402 v1 shape', () => {
    const r = buildErrorResponse('payment_required', { accepts: [sampleRequirements] });
    expect(r.body).toEqual({
      x402Version: 1,
      accepts: [sampleRequirements],
      error: 'payment_required',
    });
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('default accepts to empty array when absent', () => {
    const r = buildErrorResponse('payment_required');
    expect((r.body as { accepts: unknown[] }).accepts).toEqual([]);
  });

  it('settlement_failed body includes settlementReason sub-field', () => {
    const r = buildErrorResponse('settlement_failed', {
      accepts: [sampleRequirements],
      settlementReason: 'receipt_reverted',
    });
    expect((r.body as { settlementReason?: string }).settlementReason).toBe('receipt_reverted');
  });

  it('insufficient_amount body includes required and received', () => {
    const r = buildErrorResponse('insufficient_amount', {
      accepts: [sampleRequirements],
      required: '10000',
      received: '5000',
    });
    expect((r.body as { required?: string; received?: string }).required).toBe('10000');
    expect((r.body as { required?: string; received?: string }).received).toBe('5000');
  });

  it('to_mismatch is the canonical reason string', () => {
    const r = buildErrorResponse('to_mismatch', { accepts: [sampleRequirements] });
    expect((r.body as { error: string }).error).toBe('to_mismatch');
    // No accidental regression to 'recipient_mismatch':
    expect(JSON.stringify(r.body)).not.toContain('recipient_mismatch');
  });

  it('uses canonical reason strings (no aliases)', () => {
    expect((buildErrorResponse('invalid_signature').body as { error: string }).error).toBe(
      'invalid_signature',
    );
    expect((buildErrorResponse('insufficient_amount').body as { error: string }).error).toBe(
      'insufficient_amount',
    );
  });

  it('content-type header is application/json; charset=utf-8', () => {
    const r = buildErrorResponse('payment_required');
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});

describe('MalformedPaymentHeaderError', () => {
  it('exposes reason and detail', () => {
    const e = new MalformedPaymentHeaderError('header_too_large', { phase: 'size', path: '$' });
    expect(e.reason).toBe('header_too_large');
    expect(e.detail.phase).toBe('size');
    expect(e.name).toBe('MalformedPaymentHeaderError');
    expect(e).toBeInstanceOf(Error);
  });
});
