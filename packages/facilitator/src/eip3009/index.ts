/**
 * `@universal-paywall/facilitator/eip3009` — the x402 `exact` scheme core.
 *
 * Verify (EIP-712 recovery + replay store) and settle (relayer-signed
 * `USDC.transferWithAuthorization`) for EIP-3009 payments, plus the
 * `NETWORKS` registry and the opaque relayer-key wrapper. Consumed by:
 *
 *   - the facilitator's own HTTP surface (`POST /verify`, `POST /settle`);
 *   - `@universal-paywall/middleware`, whose embedded self-facilitating
 *     mode imports this core (its old module paths re-export from here).
 *
 * The class `OpaqueRelayerKey` and its structural interface share a name in
 * their home modules; this index exports the class as `OpaqueRelayerKey`
 * and the type-only shape as `OpaqueRelayerKeyShape`, mirroring the
 * middleware package surface.
 */

export { NETWORKS, normalizeNetworkId } from './networks.js';

// `getRelayerKeySecret` is deliberately NOT exported here: extraction of the
// raw relayer key stays gated to `settle.ts` (and the repo-root register CLI),
// both of which import `./relayer-key.js` by module path. Keeping it off the
// published subpath preserves the D13 containment contract.
export { OpaqueRelayerKey, scrubSecrets } from './relayer-key.js';

export { NonceStore } from './replay-store.js';
export type {
  CheckAndInsertInput,
  CheckAndInsertResult,
  HasInput,
  InsertInput,
  NonceStoreOptions,
} from './replay-store.js';

export { verifyEip3009Authorization } from './verify.js';
export type { VerifyOptions, VerifyReason, VerifyResult } from './verify.js';

// `__resetSettleCacheForTests` is also NOT exported: the tests that need it
// live in this package and import `../settle.js` directly.
export { MIN_RELAYER_USDC_BALANCE, NetworkMismatchError, settleOnChain } from './settle.js';
export type {
  PublicClientLike,
  SettleOptions,
  SettleReason,
  SettleResult,
  SettlementFailedReason,
} from './settle.js';

export type {
  ExactEvmPayload,
  NetworkConfig,
  OpaqueRelayerKey as OpaqueRelayerKeyShape,
  PaymentPayload,
  PaymentRequirements,
} from './types.js';
