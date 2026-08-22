/**
 * Re-export shim. `verifyEip3009Authorization` moved to the facilitator
 * package (U1 decision: chain verification is facilitator-domain logic).
 * This path is kept so `core.ts` and downstream imports stay stable.
 */

export { verifyEip3009Authorization } from '@universal-paywall/facilitator/eip3009';
export type {
  VerifyOptions,
  VerifyReason,
  VerifyResult,
} from '@universal-paywall/facilitator/eip3009';
