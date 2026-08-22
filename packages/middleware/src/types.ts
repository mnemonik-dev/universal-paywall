/**
 * Public TypeScript surface for `@universal-paywall/middleware`.
 *
 * The x402 `exact` wire types (`NetworkConfig`, `PaymentRequirements`,
 * `ExactEvmPayload`, `PaymentPayload`) and the `OpaqueRelayerKey` shape
 * moved to `@universal-paywall/facilitator/eip3009` with the verify/settle
 * core (U1 decision) and are re-exported here unchanged, so this module
 * remains the one import site for middleware code and integrators.
 *
 * Middleware-specific types (`PaywallConfig`, the D18 SecurityLogger
 * catalog) live below. Field shapes are byte-for-byte with tech-spec
 * "Data Models → Middleware types".
 */

import type { OpaqueRelayerKeyShape as OpaqueRelayerKey } from '@universal-paywall/facilitator/eip3009';

export type {
  ExactEvmPayload,
  NetworkConfig,
  OpaqueRelayerKeyShape as OpaqueRelayerKey,
  PaymentPayload,
  PaymentRequirements,
} from '@universal-paywall/facilitator/eip3009';

export interface PaywallConfig {
  price: string;
  developerEoa: `0x${string}`;
  network: string;
  facilitator: {
    mode: 'inline';
    relayerKey: OpaqueRelayerKey;
    rpcUrl?: string;
  };
  resource?: string;
  description?: string;
  mimeType?: string;
  logger?: SecurityLogger;
}

/**
 * Typed D18 SecurityLogger event catalog (per tech-spec D18 + task-8 spec).
 *
 * Event names follow the tech-spec D18 catalog (`signature_invalid`,
 * `nonce_replay_attempt`).
 * Hash-shaped fields (`payerHash`, `developerEoaHash`, `nonceHash`) are the
 * canonical 10-char form: `'0x' + keccak256(input).slice(2, 10)` (per
 * iteration-3 addendum §5). Raw addresses and raw nonces never appear in
 * event payloads.
 *
 * `payerHash` provenance: events emitted AFTER EIP-712 recovery
 * (settlement_failed, nonce_replay_attempt, authorization_expired,
 * authorization_not_yet_valid, signature_invalid, to_mismatch,
 * relayer_low_balance) hash the cryptographically recovered signer. Events
 * emitted BEFORE recovery (paused_request, vault_not_deployed, the early
 * rpc_5xx surfacing) hash the claimed-on-the-wire `authorization.from` —
 * the recovered address is not yet available at that point. This is
 * structurally unavoidable and accepted as a minor information-disclosure
 * trade-off (the hash is one-way and 10-char, so the asymmetry is
 * forensic-only).
 */
export interface SecurityEventCatalog {
  signature_invalid: { payerHash: string; network: string };
  nonce_replay_attempt: { payerHash: string; nonceHash: string };
  authorization_expired: { payerHash: string };
  authorization_not_yet_valid: { payerHash: string };
  network_mismatch: { expected: string; received: string };
  to_mismatch: { payerHash: string };
  insufficient_amount: { required: string; received: string };
  settlement_failed: { payerHash: string; reason: string; txHash?: string };
  paused_request: { developerEoaHash: string };
  vault_not_deployed: { developerEoaHash: string };
  header_too_large: { size: number };
  malformed_header: { phase: 'base64' | 'json' | 'shape' };
  chain_id_mismatch: { expectedChainId: number; observedChainId: number; network: string };
  relayer_low_balance: { balanceUsdc: string };
}

export type SecurityEventName = keyof SecurityEventCatalog;

/**
 * Optional logger that integrators wire on `PaywallConfig.logger`. Emission
 * is fire-and-forget — `securityEvent` throws are swallowed by the
 * middleware so a misconfigured logger never blocks the request path.
 */
export interface SecurityLogger {
  securityEvent<N extends SecurityEventName>(name: N, payload: SecurityEventCatalog[N]): void;
}
