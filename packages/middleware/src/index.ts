export type {
  ExactEvmPayload,
  NetworkConfig,
  OpaqueRelayerKey as OpaqueRelayerKeyShape,
  PaymentPayload,
  PaymentRequirements,
  PaywallConfig,
} from './types.js';

export {
  build402Body,
  decodeXPayment,
  encodeXPaymentResponse,
  InvalidPriceError,
  MalformedPaymentHeaderError,
  parseUsdPrice,
} from './x402.js';
export type { MalformedHeaderDetail, X402ChallengeBody, XPaymentResponse } from './x402.js';

export { buildErrorResponse, NetworkMismatchError } from './errors.js';
export type {
  ErrorContext,
  ErrorReason,
  ErrorReason400,
  ErrorReason402,
  ErrorResponseEnvelope,
  SettlementSubReason,
} from './errors.js';

export { verifyEip3009Authorization } from './verify.js';
export type { VerifyOptions, VerifyReason, VerifyResult } from './verify.js';

export { MIN_RELAYER_USDC_BALANCE, settleOnChain } from './settle.js';
export type { PublicClientLike, SettleOptions, SettleReason, SettleResult } from './settle.js';

export { NETWORKS, normalizeNetworkId } from './networks.js';

// NOTE: `getRelayerKeySecret` is intentionally NOT re-exported here.
// It is the only path to extract the wrapped key, and only `settle.ts`
// (which imports it directly from `./relayer-key.js`) should consume it.
// Keeping it off the package's public surface prevents downstream
// applications from accidentally discovering / using it.
export { OpaqueRelayerKey, scrubSecrets } from './relayer-key.js';

export { NonceStore } from './replay-store.js';
export type {
  CheckAndInsertInput,
  CheckAndInsertResult,
  HasInput,
  InsertInput,
  NonceStoreOptions,
} from './replay-store.js';
