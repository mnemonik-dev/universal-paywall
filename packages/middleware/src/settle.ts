/**
 * Re-export shim. `settleOnChain` and the settlement classifier moved to
 * the facilitator package (U1 decision: chain settlement is
 * facilitator-domain logic). This path is kept so `core.ts` and the
 * remaining middleware tests stay stable.
 */

export {
  MIN_RELAYER_USDC_BALANCE,
  NetworkMismatchError,
  __resetSettleCacheForTests,
  settleOnChain,
} from '@universal-paywall/facilitator/eip3009';
export type {
  PublicClientLike,
  SettleOptions,
  SettleReason,
  SettleResult,
  SettlementFailedReason,
} from '@universal-paywall/facilitator/eip3009';
