import { createPublicClient, http } from 'viem';
import { buildChain } from './chain.js';
import { stakeVaultAbi } from './abi.js';
import type { Hex } from './types.js';

/**
 * x402 edge for the stake rail. A resource server gates a request on the payer
 * having an active grant to *this* facilitator; if not, it answers `402` with
 * the instructions the agent needs to fund a vault and grant a policy, then
 * retries.
 */

export interface Build402Opts {
  /** Payer EOA (from the agent's `X-PAYMENT`/identity). */
  payer: Hex;
  /** Payer's counterfactual vault address (compute via the factory). */
  vault: Hex;
  /** CAIP-2 network id, e.g. `eip155:5042002`. */
  network: string;
  /** USDC asset address. */
  asset: Hex;
  /** Facilitator session-key address the agent must grant to. */
  facilitator: Hex;
  /** Deployed StakeVaultFactory. */
  stakeVaultFactory: Hex;
  /** Suggested cap (micro-USDC) for the grant. */
  recommendedCap: bigint;
  /** Suggested policy lifetime in seconds (default 1 hour). */
  validForSeconds?: number;
  resource?: string;
  description?: string;
}

export interface Payment402Body {
  x402Version: 1;
  error: 'payment_required';
  accepts: Array<{
    scheme: 'stake';
    network: string;
    asset: Hex;
    payTo: Hex;
    maxAmountRequired: string;
  }>;
  grant: {
    facilitator: Hex;
    stakeVaultFactory: Hex;
    vault: Hex;
    recommendedCap: string;
    validForSeconds: number;
    instructions: string;
  };
  resource?: string;
  description?: string;
}

/** Builds the `402 Payment Required` body describing the stake grant to make. */
export function build402Body(opts: Build402Opts): Payment402Body {
  const validForSeconds = opts.validForSeconds ?? 3600;
  const body: Payment402Body = {
    x402Version: 1,
    error: 'payment_required',
    accepts: [
      {
        scheme: 'stake',
        network: opts.network,
        asset: opts.asset,
        payTo: opts.vault,
        maxAmountRequired: opts.recommendedCap.toString(),
      },
    ],
    grant: {
      facilitator: opts.facilitator,
      stakeVaultFactory: opts.stakeVaultFactory,
      vault: opts.vault,
      recommendedCap: opts.recommendedCap.toString(),
      validForSeconds,
      instructions:
        'createVault(payer) if needed, approve+deposit USDC into the vault, then ' +
        'grantPolicy(facilitator, cap, validUntil), and retry.',
    },
  };
  if (opts.resource !== undefined) body.resource = opts.resource;
  if (opts.description !== undefined) body.description = opts.description;
  return body;
}

export interface OnChainPolicy {
  facilitator: Hex;
  cap: bigint;
  spent: bigint;
  validUntil: bigint;
  epoch: bigint;
}

/** Reads a vault's active policy. Injectable so the gate is testable off-chain. */
export type PolicyReader = (vault: Hex) => Promise<OnChainPolicy>;

export interface GrantCheck {
  ok: boolean;
  reason?: string;
  remaining?: bigint;
}

/**
 * Gate used by the resource server: passes only if `vault` has an active,
 * unexpired grant to `facilitator` with at least `minRemaining` headroom.
 */
export async function checkGrant(
  read: PolicyReader,
  opts: { vault: Hex; facilitator: Hex; minRemaining: bigint; now?: number },
): Promise<GrantCheck> {
  const p = await read(opts.vault);
  if (p.facilitator === '0x0000000000000000000000000000000000000000') {
    return { ok: false, reason: 'no_grant' };
  }
  if (p.facilitator.toLowerCase() !== opts.facilitator.toLowerCase()) {
    return { ok: false, reason: 'grant_to_other_facilitator' };
  }
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  if (p.validUntil <= now) return { ok: false, reason: 'grant_expired' };
  const remaining = p.cap > p.spent ? p.cap - p.spent : 0n;
  if (remaining < opts.minRemaining) return { ok: false, reason: 'insufficient_remaining', remaining };
  return { ok: true, remaining };
}

/** viem-backed `PolicyReader` against a live chain. */
export function createPolicyReader(config: { rpcUrl: string; chainId: number }): PolicyReader {
  const chain = buildChain(config.chainId, config.rpcUrl);
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const ZERO_POLICY: OnChainPolicy = {
    facilitator: '0x0000000000000000000000000000000000000000',
    cap: 0n,
    spent: 0n,
    validUntil: 0n,
    epoch: 0n,
  };
  return async (vault: Hex): Promise<OnChainPolicy> => {
    try {
      const r = (await pub.readContract({
        address: vault,
        abi: stakeVaultAbi,
        functionName: 'policy',
      })) as readonly [Hex, bigint, bigint, bigint, bigint];
      return { facilitator: r[0], cap: r[1], spent: r[2], validUntil: r[3], epoch: r[4] };
    } catch {
      // Vault not deployed yet (no code at the counterfactual address) or the
      // read failed — treat as "no grant" so the gate returns a clean 402
      // rather than throwing.
      return ZERO_POLICY;
    }
  };
}

