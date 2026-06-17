/**
 * Public ESM exports for `@universal-paywall/middleware`.
 *
 * Surface limited to the integrator-facing API per task-8 spec:
 *   - `withPaywall` (Node http adapter)
 *   - `fastifyPaywall` (Fastify plugin)
 *   - `NETWORKS` (chain registry)
 *   - `SecurityLogger` (typed event interface) + event catalog types
 *   - Public types: `PaywallConfig`, `NetworkConfig`, `PaymentRequirements`,
 *     `PaymentPayload`, `ExactEvmPayload`, `OpaqueRelayerKey`.
 *
 * Internal helpers are intentionally NOT re-exported: `verify`, `settle`,
 * `NonceStore`, the `OpaqueRelayerKey` extract symbol, `FactoryStateCache`,
 * `replay-store` internals.
 */

export { withPaywall } from './adapters/node-http.js';
export type { NodeHttpHandler } from './adapters/node-http.js';

export { fastifyPaywall } from './adapters/fastify.js';

export { NETWORKS } from './networks.js';

export type {
  SecurityLogger,
  SecurityEventCatalog,
  SecurityEventName,
  PaywallCoreOptions,
  PaywallRequest,
  PaywallResult,
} from './core.js';

// OpaqueRelayerKey: the class is the public constructor agents use to wrap a
// raw private key. The internal `getRelayerKeySecret` extract function is
// NOT exported (settle.ts imports it directly from `./relayer-key.js`).
export { OpaqueRelayerKey } from './relayer-key.js';

export type {
  ExactEvmPayload,
  NetworkConfig,
  OpaqueRelayerKey as OpaqueRelayerKeyShape,
  PaymentPayload,
  PaymentRequirements,
  PaywallConfig,
} from './types.js';
