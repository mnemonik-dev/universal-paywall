export type Hex = `0x${string}`;

/** Static configuration for an external facilitator process. */
export interface FacilitatorConfig {
  /** JSON-RPC endpoint for the target chain. */
  rpcUrl: string;
  /** EIP-155 chain id (asserted against the RPC on first settle). */
  chainId: number;
  /** Session-key EOA private key — the address registered in each payer policy. */
  facilitatorKey: Hex;
  /** Deployed `StakeVaultFactory` address (used to resolve per-payer vaults). */
  stakeVaultFactory: Hex;
  /** Accepted creator API keys (charge calls authenticate with one of these). */
  apiKeys: ReadonlyArray<string>;
  /** Batching window: flush a payer's charges at N pending or after maxAgeMs. */
  batch: { maxCharges: number; maxAgeMs: number };
}

/** A metered charge submitted by a creator/platform for a given payer. */
export interface ChargeRequest {
  /** Payer EOA; the on-chain vault address is derived from this. */
  payer: Hex;
  /** Creator/payee address that receives the settled USDC. */
  creator: Hex;
  /** Amount in micro-USDC (6 decimals). */
  amount: bigint;
  /** Optional idempotency / audit reference. */
  ref?: string;
}

export interface RecordedCharge extends ChargeRequest {
  id: string;
  receivedAt: number;
}

/** One batched settlement against a single payer's vault. */
export interface SettlementBatch {
  payer: Hex;
  vault: Hex;
  creators: Hex[];
  amounts: bigint[];
  chargeIds: string[];
  total: bigint;
}

export interface SettleResult {
  ok: boolean;
  txHash?: Hex;
  reason?: string;
}

/** Pluggable on-chain settlement boundary (real or test double). */
export interface Settler {
  settle(batch: SettlementBatch): Promise<SettleResult>;
}

/** Resolves a payer EOA to its (counterfactual) vault address. */
export type VaultResolver = (payer: Hex) => Promise<Hex>;
