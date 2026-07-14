import type { Hex } from './types.js';

export interface OperationBinding {
  version: 1;
  operation_id: string;
  payer_subject: string;
  payer_wallet: Hex;
  artifact_hash: string;
  amount: string;
  asset: Hex;
  network: string;
  pay_to: Hex;
  expires_at: string;
  nonce: string;
  scope: OperationScope;
}

export type CheckpointAction = 'manual' | 'pre_compaction' | 'session_end';

export interface OperationScope {
  workspace_hash?: Hex;
  visibility: string;
  action: CheckpointAction;
}

export interface SessionAuthorization {
  version: 1;
  service_id: string;
  session_id: string;
  payer_subject: string;
  payer_wallet: Hex;
  vault: Hex;
  facilitator: Hex;
  pay_to: Hex;
  cap: string;
  per_operation_ceiling: string;
  valid_until: string;
  network: string;
  asset: Hex;
  policy_epoch: string;
  workspace_hash: Hex;
  visibility: string;
  allowed_actions: CheckpointAction[];
  nonce: Hex;
}

export interface RegisterSessionRequest {
  authorization: SessionAuthorization;
  signature: Hex;
}

export interface SessionOperationAuthorization {
  workspace_hash: Hex;
  visibility: string;
  action: CheckpointAction;
}

export type PaymentAuthorization =
  | {
      scheme: 'stake';
      session_id: string;
      payer_wallet: Hex;
      authorization: SessionOperationAuthorization;
    }
  | {
      scheme: 'exact';
      payer_wallet: Hex;
      authorization: ExactAuthorization;
    };

export interface ExactAuthorization {
  signature: Hex;
  authorization: {
    from: Hex;
    to: Hex;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

export interface SettleRequest {
  binding: OperationBinding;
  payment: PaymentAuthorization;
}

export interface SignedReceiptPayload {
  version: 1;
  service_id: string;
  operation_id: string;
  scheme: 'stake' | 'exact';
  binding_digest: Hex;
  payer_wallet: Hex;
  amount: string;
  asset: Hex;
  network: string;
  pay_to: Hex;
  settlement_tx: Hex;
  settled_at: string;
}

export interface SignedProviderReceipt {
  payload: SignedReceiptPayload;
  signature: {
    algorithm: 'Ed25519';
    key_id: string;
    value: string;
  };
}

/** Shape consumed by Mnemonic's provider-neutral Rust client. */
export interface PaymentReceipt {
  operation_id: string;
  scheme: 'stake' | 'exact';
  status: 'settled';
  binding_digest: Hex;
  payer_wallet: Hex;
  amount: string;
  asset: Hex;
  network: string;
  pay_to: Hex;
  settlement_tx: Hex;
  settled_at: string;
  receipt: SignedProviderReceipt;
}

export type PaymentState = 'created' | 'settling' | 'settled' | 'failed_retryable' | 'rejected';

export interface ProviderPaymentStatus {
  operation_id: string;
  status: PaymentState;
  /** The immutable operation binding this payment is for. */
  binding?: OperationBinding;
  receipt?: PaymentReceipt;
  error?: string;
}

export interface PaidSession {
  session_id: string;
  status: 'active' | 'revoked' | 'expired' | 'superseded';
  authorization: SessionAuthorization;
  remaining: string;
  funded_balance: string;
  created_at: string;
}

export interface SessionPolicy {
  facilitator: Hex;
  pay_to: Hex;
  cap: bigint;
  spent: bigint;
  per_operation_ceiling: bigint;
  valid_until: bigint;
  epoch: bigint;
  scope_hash: Hex;
  revoked: boolean;
  funded_balance: bigint;
}

export interface SessionPolicyReader {
  read(vault: Hex): Promise<SessionPolicy>;
}

export interface SessionVaultVerifier {
  isTrustedVault(vault: Hex, payer: Hex): Promise<boolean>;
}

export interface SessionPolicyRegistrar {
  register(request: RegisterSessionRequest): Promise<{ tx_hash: Hex }>;
}

export interface SettlementInput {
  vault: Hex;
  operation_id: Hex;
  policy_epoch: bigint;
  amount: bigint;
  pay_to: Hex;
}

export type SettlementResult =
  | { status: 'settled'; tx_hash: Hex }
  | { status: 'uncertain'; reason: string }
  | { status: 'failed'; reason: string };

export interface SessionOperationSettler {
  settle(input: SettlementInput): Promise<SettlementResult>;
  reconcile(input: SettlementInput): Promise<{ settled: boolean; tx_hash?: Hex }>;
}

export interface ExactPaymentSettler {
  settle(binding: OperationBinding, proof: ExactAuthorization): Promise<SettlementResult>;
  reconcile(
    binding: OperationBinding,
    proof: ExactAuthorization,
  ): Promise<{ settled: boolean; tx_hash?: Hex }>;
}
