/**
 * verifyEip3009Authorization — off-chain EIP-712 signature verification gate.
 *
 * Per tech-spec D5 + Solution step 7c (and systemic-fixes §4, addendum §3/§8):
 *
 *   1. EIP-712 domain is built from `NETWORKS[opts.expectedNetwork]` —
 *      `usdcEip712Name`, `usdcEip712Version`, `chainId`, `usdcAddress`. The
 *      domain is bound to the *configured* network, so a signature produced
 *      for any other chain (or any other USDC contract) fails to recover.
 *
 *   2. `viem.recoverTypedDataAddress` walks the standard EIP-3009
 *      `TransferWithAuthorization` typed-data structure.
 *
 *   3. Seven Solution-7c checks run in order; the first to fail returns a
 *      canonical reason string from the systemic-fixes §4 catalogue:
 *        - recovered != from              → `invalid_signature`
 *        - to != expectedVaultAddress     → `to_mismatch`
 *        - value < maxAmountRequired      → `insufficient_amount`
 *        - validBefore <= now + 5 000 ms  → `authorization_expired`
 *        - validAfter > now               → `authorization_not_yet_valid`
 *        - payload.network ≠ expected     → `network_mismatch`
 *        - NonceStore.has → true          → `nonce_already_used`
 *
 *   4. Time fields (`validBefore`, `validAfter`) arrive as unix-seconds
 *      decimal-integer strings per EIP-3009. They are converted to
 *      milliseconds (`Number(field) * 1000`) before comparison against
 *      `opts.nowMs`. `SAFETY_MARGIN_MS = 5_000`.
 *
 *   5. After all checks pass, `nonceStore.has(...)` is followed *synchronously*
 *      by `nonceStore.insert(...)` — no `await` between them, no other state
 *      mutation in the gap. This closes the TOCTOU window per D5.
 *
 * This module is the security gate. It does NOT emit any security events —
 * per systemic-fixes-3 §2, `core.ts` is the single owner of D18 event
 * emission. `verify.ts` returns a discriminated result; `core.ts` maps it
 * to the typed catalogue.
 *
 * The NonceStore is consumed only here; `settle.ts` never touches it.
 * Combined with the "no delete on settle failure" rule documented in
 * `replay-store.ts`, this gives the structural guarantee that a failed
 * on-chain settle leaves the replay record intact — the agent has to mint
 * a fresh nonce to retry. See Risks row "Settlement failure mid-flight".
 */

import { recoverTypedDataAddress } from 'viem';
import type { NetworkConfig, PaymentPayload } from './types.js';
import { NETWORKS, normalizeNetworkId } from './networks.js';
import type { NonceStore } from './replay-store.js';

const SAFETY_MARGIN_MS = 5_000;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type VerifyReason =
  | 'invalid_signature'
  | 'to_mismatch'
  | 'insufficient_amount'
  | 'authorization_expired'
  | 'authorization_not_yet_valid'
  | 'network_mismatch'
  | 'nonce_already_used';

export type VerifyResult =
  | { ok: true; recoveredFrom: `0x${string}` }
  | { ok: false; reason: VerifyReason };

export interface VerifyOptions {
  expectedVaultAddress: `0x${string}`;
  expectedNetwork: string;
  maxAmountRequired: bigint;
  /**
   * viem PublicClient owned by core.ts. Not used by verify itself, but
   * carried in opts to give core/settle a uniform context object. Kept
   * `unknown` here to avoid a hard structural dependency on viem's
   * PublicClient generics from this module.
   */
  publicClient: unknown;
  nonceStore: NonceStore;
  nowMs?: number;
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function verifyEip3009Authorization(
  payload: PaymentPayload,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const network: NetworkConfig | undefined = (
    NETWORKS as Record<string, NetworkConfig | undefined>
  )[opts.expectedNetwork];
  if (network === undefined) {
    // Configuration error: caller passed a network we don't recognize.
    // Surface as network_mismatch — there is no "configured" domain to
    // verify against. This is a defensive branch; core.ts validates the
    // configured network at startup.
    return { ok: false, reason: 'network_mismatch' };
  }

  const { authorization, signature } = payload.payload;

  const domain = {
    name: network.usdcEip712Name,
    version: network.usdcEip712Version,
    chainId: network.chainId,
    verifyingContract: network.usdcAddress,
  } as const;

  let recovered: `0x${string}`;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }

  if (!addressesEqual(recovered, authorization.from)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  if (!addressesEqual(authorization.to, opts.expectedVaultAddress)) {
    return { ok: false, reason: 'to_mismatch' };
  }

  if (BigInt(authorization.value) < opts.maxAmountRequired) {
    return { ok: false, reason: 'insufficient_amount' };
  }

  const validBeforeMs = Number(authorization.validBefore) * 1000;
  if (validBeforeMs <= nowMs + SAFETY_MARGIN_MS) {
    return { ok: false, reason: 'authorization_expired' };
  }

  const validAfterMs = Number(authorization.validAfter) * 1000;
  if (validAfterMs > nowMs) {
    return { ok: false, reason: 'authorization_not_yet_valid' };
  }

  const payloadCanonical = normalizeNetworkId(payload.network);
  const expectedCanonical = normalizeNetworkId(opts.expectedNetwork);
  if (
    payloadCanonical === undefined ||
    expectedCanonical === undefined ||
    payloadCanonical !== expectedCanonical
  ) {
    return { ok: false, reason: 'network_mismatch' };
  }

  // Synchronous TOCTOU-safe block — handled inside NonceStore.checkAndInsert,
  // which is the documented production primitive (replay-store.ts marks
  // `insert` as "Test-only"). `checkAndInsert` additionally enforces a
  // defense-in-depth safety net: `validBefore <= now` is refused here too,
  // so a future regression that drops the 5s margin check above can't
  // sneak an already-dead authorization into the store.
  const checkResult = opts.nonceStore.checkAndInsert({
    from: authorization.from,
    nonce: authorization.nonce,
    validBefore: validBeforeMs,
    now: nowMs,
  });
  if (!checkResult.accepted) {
    return { ok: false, reason: checkResult.reason };
  }

  return { ok: true, recoveredFrom: recovered };
}
