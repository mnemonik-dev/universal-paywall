/**
 * Public ESM exports for `@universal-paywall/middleware`.
 *
 * Surface limited to the integrator-facing API per task-8 spec:
 *   - `withPaywall` (Node http adapter)
 *   - `fastifyPaywall` (Fastify plugin)
 *   - `NETWORKS` (chain registry)
 *   - `OpaqueRelayerKey` (relayer-key constructor)
 *   - Public types: `PaywallConfig`, `NetworkConfig`, `PaymentRequirements`,
 *     `PaymentPayload`, `ExactEvmPayload`, `OpaqueRelayerKey` (shape),
 *     `SecurityLogger`, `SecurityEventCatalog`, `SecurityEventName`.
 *
 * Internal helpers are intentionally NOT re-exported: `verify`, `settle`,
 * `NonceStore`, the `OpaqueRelayerKey` extract symbol, `FactoryStateCache`,
 * `replay-store` internals, `PaywallCoreOptions`, `PaywallRequest`,
 * `PaywallResult` (core's adapter-facing types).
 */

export { withPaywall } from './adapters/node-http.js';
export type { NodeHttpHandler } from './adapters/node-http.js';

export { fastifyPaywall } from './adapters/fastify.js';

export { NETWORKS } from './networks.js';

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
  SecurityEventCatalog,
  SecurityEventName,
  SecurityLogger,
} from './types.js';
