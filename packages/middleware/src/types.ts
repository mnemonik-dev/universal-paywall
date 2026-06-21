/**
 * Public TypeScript surface for `@universal-paywall/middleware`.
 *
 * ESM, type-only. Concrete implementations live in sibling modules:
 *   - `OpaqueRelayerKey` is implemented by the class in `relayer-key.ts`.
 *   - `NetworkConfig` rows live in `networks.ts`.
 *
 * Field shapes are byte-for-byte with tech-spec "Data Models → Middleware types".
 */

export interface NetworkConfig {
  id: string;
  alias: string;
  chainId: number;
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  usdcEip712Name: string;
  usdcEip712Version: string;
  factoryAddress: `0x${string}`;
  vaultImplAddress: `0x${string}`;
  enabled: boolean;
}

/**
 * Opaque wrapper for the relayer EOA private key.
 *
 * The structural shape is intentionally empty: the class implementation in
 * `relayer-key.ts` stores the secret in a private (`#key`) field that is not
 * visible to the structural type system or to `JSON.stringify` / `Object.keys`.
 *
 * Extraction is gated through `getRelayerKeySecret(key)` in `relayer-key.ts`
 * — only `settle.ts` should import that function.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OpaqueRelayerKey {}

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

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  asset: `0x${string}`;
  extra: { assetTransferMethod: 'eip3009'; name: string; version: string };
}

export interface ExactEvmPayload {
  signature: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  payload: ExactEvmPayload;
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
