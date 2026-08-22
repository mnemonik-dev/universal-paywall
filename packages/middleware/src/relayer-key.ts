/**
 * Re-export shim. `OpaqueRelayerKey` and its extraction gate moved to the
 * facilitator package with `settle.ts` (U1 decision). The containment
 * contract is unchanged: only the facilitator's `settle.ts` imports
 * `getRelayerKeySecret`; middleware code touches the class and
 * `scrubSecrets` only.
 */

export {
  OpaqueRelayerKey,
  getRelayerKeySecret,
  scrubSecrets,
} from '@universal-paywall/facilitator/eip3009';
