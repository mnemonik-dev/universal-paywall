import { build402Body, checkGrant, type Hex, type PolicyReader } from '@universal-paywall/facilitator';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

/** Static config for the resource-server gate. */
export interface GateConfig {
  /** CAIP-2 network id (e.g. `eip155:5042002`). */
  network: string;
  /** USDC asset address. */
  asset: Hex;
  /** Facilitator session-key address that payers must grant to. */
  facilitatorAddress: Hex;
  /** Deployed StakeVaultFactory. */
  stakeVaultFactory: Hex;
  /** Price per successful request, micro-USDC. */
  price: bigint;
  /** Minimum on-chain grant headroom required (default = price). */
  minRemaining?: bigint;
  /** Cap suggested to the agent in the 402 (default = price * 1000). */
  recommendedCap?: bigint;
  /** Allowed clock skew for the payer proof, seconds (default 120). */
  signatureWindowSeconds?: number;
  resource?: string;
  description?: string;
}

/** Injected chain/crypto dependencies (real viem in node adapter, fakes in tests). */
export interface GateDeps {
  resolveVault: (payer: Hex) => Promise<Hex>;
  readPolicy: PolicyReader;
  /** Recovers the signer of a personal-sign message. */
  recoverPayer: (message: string, signature: Hex) => Promise<Hex>;
  /** Current time in ms (default Date.now). */
  now?: () => number;
}

/** Headers the agent presents to prove control of `payer`. */
export interface AccessHeaders {
  payer?: string | undefined;
  timestamp?: string | undefined;
  signature?: string | undefined;
}

export type AccessDecision =
  | { allow: true; payer: Hex; vault: Hex }
  | { allow: false; status: number; body: unknown };

export const PROOF_PREFIX = 'universal-paywall';

/** The message the payer signs to prove control for a request. */
export function proofMessage(payer: Hex, timestamp: number): string {
  return `${PROOF_PREFIX}:${payer.toLowerCase()}:${timestamp}`;
}

function isAddress(v: string | undefined): v is Hex {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

/**
 * Decides whether a request may proceed:
 *   1. payer present  → else 402 `payer_required`
 *   2. valid, in-window payer signature → else 401
 *   3. active on-chain grant to our facilitator with enough headroom
 *      → else 402 with `build402Body` instructions
 */
export async function evaluateAccess(
  headers: AccessHeaders,
  deps: GateDeps,
  cfg: GateConfig,
): Promise<AccessDecision> {
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  const minRemaining = cfg.minRemaining ?? cfg.price;
  const recommendedCap = cfg.recommendedCap ?? cfg.price * 1000n;

  if (!isAddress(headers.payer)) {
    return {
      allow: false,
      status: 402,
      body: {
        x402Version: 1,
        error: 'payer_required',
        grant: {
          facilitator: cfg.facilitatorAddress,
          stakeVaultFactory: cfg.stakeVaultFactory,
          instructions:
            'Set X-Payer plus a signed X-Payer-Timestamp / X-Payer-Signature, grant a policy to the facilitator, and retry.',
        },
      },
    };
  }
  const payer = headers.payer.toLowerCase() as Hex;

  const ts = Number(headers.timestamp);
  const sig = headers.signature;
  if (sig === undefined || !HEX_RE.test(sig) || !Number.isFinite(ts)) {
    return { allow: false, status: 401, body: { error: 'payer_proof_required' } };
  }
  const window = cfg.signatureWindowSeconds ?? 120;
  if (Math.abs(nowSec - ts) > window) {
    return { allow: false, status: 401, body: { error: 'proof_timestamp_out_of_window' } };
  }
  const recovered = (await deps.recoverPayer(proofMessage(payer, ts), sig as Hex)).toLowerCase();
  if (recovered !== payer) {
    return { allow: false, status: 401, body: { error: 'invalid_payer_proof' } };
  }

  const vault = await deps.resolveVault(payer);
  const grant = await checkGrant(deps.readPolicy, {
    vault,
    facilitator: cfg.facilitatorAddress,
    minRemaining,
    now: nowSec,
  });
  if (!grant.ok) {
    const body = build402Body({
      payer,
      vault,
      network: cfg.network,
      asset: cfg.asset,
      facilitator: cfg.facilitatorAddress,
      stakeVaultFactory: cfg.stakeVaultFactory,
      recommendedCap,
      ...(cfg.resource !== undefined ? { resource: cfg.resource } : {}),
      ...(cfg.description !== undefined ? { description: cfg.description } : {}),
    });
    return { allow: false, status: 402, body: { ...body, reason: grant.reason } };
  }

  return { allow: true, payer, vault };
}
