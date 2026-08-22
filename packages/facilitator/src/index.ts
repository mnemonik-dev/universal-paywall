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
export {
  canonicalJson,
  operationBindingJson,
  operationDigest,
  sessionScopeHash,
  sha256Digest,
} from './canonical.js';
export { FilePaymentStore } from './payment-store.js';
export type { PaymentStore, StoredPayment, StoredQuote, StoredSession } from './payment-store.js';
export { ReceiptSigner } from './receipt.js';
export type { ReceiptSignerOptions } from './receipt.js';
export {
  allowedActionsHash,
  sessionTypedData,
  verifySessionAuthorization,
} from './session-auth.js';
export type { SessionVerifierConfig } from './session-auth.js';
export { OnChainExactPayments, OnChainSessionPayments } from './session-chain.js';
export type { ExactChainConfig, SessionChainConfig } from './session-chain.js';
export { PaymentServiceError, SessionPaymentService } from './session-service.js';
export type {
  SessionPaymentServiceConfig,
  SessionPaymentServiceOptions,
} from './session-service.js';
export { createSessionPaymentServer } from './session-server.js';
export type { SessionServerOptions } from './session-server.js';
export { X402Facilitator } from './x402-http.js';
export type {
  X402ErrorReason,
  X402FacilitatorOptions,
  X402SettleResponse,
  X402SupportedResponse,
  X402VerifyResponse,
} from './x402-http.js';
export { build402Body, checkGrant, createPolicyReader } from './x402.js';
export type {
  Build402Opts,
  GrantCheck,
  OnChainPolicy,
  Payment402Body,
  PolicyReader,
} from './x402.js';
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
export type {
  CheckpointAction,
  ExactAuthorization,
  ExactPaymentSettler,
  OperationBinding,
  PaidSession,
  PaymentAuthorization,
  PaymentReceipt,
  PaymentState,
  ProviderPaymentStatus,
  RegisterSessionRequest,
  SessionAuthorization,
  SessionOperationAuthorization,
  SessionOperationSettler,
  SessionPolicy,
  SessionPolicyReader,
  SessionPolicyRegistrar,
  SessionVaultVerifier,
  SettleRequest as SessionSettleRequest,
  SettlementInput as SessionSettlementInput,
  SettlementResult as SessionSettlementResult,
  SignedProviderReceipt,
  SignedReceiptPayload,
} from './session-types.js';
