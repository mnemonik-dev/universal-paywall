import { ChargeLedger } from './ledger.js';
import { createFacilitatorServer } from './server.js';
import { FacilitatorService } from './service.js';
import { OnChainSettler, createVaultResolver } from './settler.js';
import type { FacilitatorConfig } from './types.js';

/**
 * Wires a full external facilitator from config: in-memory ledger, viem-backed
 * vault resolver + on-chain settler, batching service, and HTTP server.
 */
export function createFacilitator(config: FacilitatorConfig): {
  service: FacilitatorService;
  server: ReturnType<typeof createFacilitatorServer>;
  ledger: ChargeLedger;
} {
  const ledger = new ChargeLedger();
  const settler = new OnChainSettler(config);
  const resolveVault = createVaultResolver(config);
  const service = new FacilitatorService({ ledger, resolveVault, settler, batch: config.batch });
  const server = createFacilitatorServer(service, { apiKeys: config.apiKeys });
  return { service, server, ledger };
}

export { ChargeLedger } from './ledger.js';
export { buildBatch } from './batcher.js';
export { FacilitatorService } from './service.js';
export type { ServiceOptions } from './service.js';
export { OnChainSettler, createVaultResolver } from './settler.js';
export { createFacilitatorServer } from './server.js';
export type { ServerOptions } from './server.js';
export { buildChain } from './chain.js';
export { build402Body, checkGrant, createPolicyReader } from './x402.js';
export type { Build402Opts, GrantCheck, OnChainPolicy, Payment402Body, PolicyReader } from './x402.js';
export type {
  ChargeRequest,
  FacilitatorConfig,
  Hex,
  RecordedCharge,
  SettleResult,
  SettlementBatch,
  Settler,
  VaultResolver,
} from './types.js';
