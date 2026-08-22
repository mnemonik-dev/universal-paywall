/**
 * Re-export shim. `OpaqueRelayerKey` and its extraction gate moved to the
 * facilitator package with `settle.ts` (U1 decision). The containment
 * contract is unchanged: `getRelayerKeySecret` is not on the published
 * `eip3009` subpath and is not re-exported here — only the facilitator's
 * `settle.ts` (and the repo-root register CLI, via the facilitator source
 * path) import it. Middleware code touches the class and `scrubSecrets`
 * only.
 */

export { OpaqueRelayerKey, scrubSecrets } from '@universal-paywall/facilitator/eip3009';
