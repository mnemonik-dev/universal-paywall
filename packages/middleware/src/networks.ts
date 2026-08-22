/**
 * Re-export shim. The `NETWORKS` registry moved to the facilitator package
 * with the rest of the EIP-3009 core (U1 decision). The registry row for a
 * network is still the single shared object whichever package reads it —
 * both packages load the same module instance in one process.
 */

export { NETWORKS, normalizeNetworkId } from '@universal-paywall/facilitator/eip3009';
