/**
 * Typed errors and HTTP response builder for the middleware boundary.
 *
 * Two HTTP status classes per tech-spec Solution §7:
 *   - HTTP 400 — request can't be parsed: `header_too_large`, `malformed_payment_header`.
 *   - HTTP 402 — payment required / declined: everything else.
 *
 * Reason strings are CANONICAL per systemic-fix §4:
 *   `to_mismatch`     (NOT `recipient_mismatch`)
 *   `invalid_signature` (NOT `signature_invalid`)
 *   `insufficient_amount` (NOT `value_too_low`)
 *
 * Body shape is x402 v1: `{ x402Version: 1, accepts: PaymentRequirements[], error, ... }`.
 */

import type { PaymentRequirements } from './types.js';

export { MalformedPaymentHeaderError, type MalformedHeaderDetail } from './x402.js';

// ─── Canonical reason strings ──────────────────────────────────────────────────

export type ErrorReason400 = 'header_too_large' | 'malformed_payment_header';

export type ErrorReason402 =
  | 'payment_required'
  | 'invalid_signature'
  | 'insufficient_amount'
  | 'authorization_expired'
  | 'authorization_not_yet_valid'
  | 'nonce_already_used'
  | 'network_mismatch'
  | 'paused'
  | 'vault_not_deployed'
  | 'to_mismatch'
  | 'settlement_failed';

export type ErrorReason = ErrorReason400 | ErrorReason402;

export type SettlementSubReason =
  | 'rpc_timeout'
  | 'rpc_5xx'
  | 'gas_estimate_revert'
  | 'mine_timeout'
  | 'receipt_reverted'
  | 'relayer_no_balance'
  | 'authorization_already_used_onchain';

const REASONS_400: ReadonlySet<ErrorReason> = new Set<ErrorReason>([
  'header_too_large',
  'malformed_payment_header',
]);

// ─── buildErrorResponse ────────────────────────────────────────────────────────

export interface ErrorContext {
  accepts?: PaymentRequirements[];
  settlementReason?: SettlementSubReason;
  detail?: unknown;
  required?: string;
  received?: string;
}

export interface ErrorResponseEnvelope {
  status: 400 | 402;
  headers: Record<string, string>;
  body: {
    x402Version: 1;
    accepts: PaymentRequirements[];
    error: ErrorReason;
    settlementReason?: SettlementSubReason;
    required?: string;
    received?: string;
  };
}

export function buildErrorResponse(reason: ErrorReason, ctx?: ErrorContext): ErrorResponseEnvelope {
  const status: 400 | 402 = REASONS_400.has(reason) ? 400 : 402;
  const body: ErrorResponseEnvelope['body'] = {
    x402Version: 1,
    accepts: ctx?.accepts ?? [],
    error: reason,
  };
  if (ctx?.settlementReason !== undefined) {
    body.settlementReason = ctx.settlementReason;
  }
  if (ctx?.required !== undefined) {
    body.required = ctx.required;
    if (ctx.received !== undefined) {
      body.received = ctx.received;
    }
  }
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  };
}
