/**
 * Wire types for the x402 `exact` scheme (EIP-3009) core.
 *
 * Extracted from `@universal-paywall/middleware` (see
 * work/x402-facilitator-endpoints/U1-expose-facilitator-endpoints.md,
 * Decisions): chain verification/settlement is facilitator-domain logic, so
 * the core lives here and `middleware` imports it for its embedded
 * self-facilitating mode. Middleware-specific types (`PaywallConfig`,
 * `SecurityLogger`, the D18 event catalog) stay in the middleware package.
 *
 * Field shapes are byte-for-byte with tech-spec "Data Models → Middleware
 * types".
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
