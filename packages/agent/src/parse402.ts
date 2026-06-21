import type { Hex } from './proof.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^[0-9]+$/;

/** Grant the agent must establish, parsed from a `402` response body. */
export interface GrantRequirements {
  facilitator: Hex;
  stakeVaultFactory: Hex;
  recommendedCap: bigint;
  validForSeconds: number;
}

function isAddress(v: unknown): v is Hex {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

/**
 * Extracts the grant requirements from a `402` body produced by
 * `build402Body`. Returns null when the body lacks a fully-specified grant
 * (e.g. the bare `payer_required` challenge, which carries no `recommendedCap`).
 */
export function parseGrantRequirements(body: unknown): GrantRequirements | null {
  if (body === null || typeof body !== 'object') return null;
  const grant = (body as { grant?: unknown }).grant;
  if (grant === null || typeof grant !== 'object') return null;
  const g = grant as Record<string, unknown>;

  if (!isAddress(g.facilitator) || !isAddress(g.stakeVaultFactory)) return null;
  if (typeof g.recommendedCap !== 'string' || !UINT_RE.test(g.recommendedCap)) return null;

  const validForSeconds = typeof g.validForSeconds === 'number' ? g.validForSeconds : 3600;

  return {
    facilitator: g.facilitator,
    stakeVaultFactory: g.stakeVaultFactory,
    recommendedCap: BigInt(g.recommendedCap),
    validForSeconds,
  };
}
