import type { Hex } from '@universal-paywall/facilitator';

/** Shared options for every resource-server adapter (node, fastify, …). */
export interface StakePaywallOptions {
  /** Price charged per successful request, micro-USDC. */
  price: bigint;
  /** This creator's payout address. */
  creator: Hex;
  /** Chain endpoint + rail addresses. */
  chain: {
    rpcUrl: string;
    chainId: number;
    network: string;
    asset: Hex;
    facilitatorAddress: Hex;
    stakeVaultFactory: Hex;
  };
  /** Where to report usage. */
  facilitator: { url: string; apiKey: string };
  minRemaining?: bigint;
  recommendedCap?: bigint;
  signatureWindowSeconds?: number;
  resource?: string;
  description?: string;
  /** Called when post-serve usage reporting fails (default: console.error). */
  onChargeError?: (err: unknown) => void;
}
