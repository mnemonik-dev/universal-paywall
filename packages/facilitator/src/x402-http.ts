/**
 * x402 v1 facilitator API (U1) — the spec HTTP surface over the eip3009 core.
 *
 * Three operations, wired into `session-server.ts`:
 *   POST /verify    → verify an exact/EIP-3009 payment WITHOUT committing
 *                     payment state (spec §7.1: read-only; the replay store
 *                     is consulted via the non-mutating peek).
 *   POST /settle    → re-verify with the consuming path (this is where the
 *                     nonce is burned), then write
 *                     `USDC.transferWithAuthorization` on-chain. Idempotent
 *                     per authorization: a repeat of the EXACT settled
 *                     envelope (fingerprint-bound — never just (from,
 *                     nonce), which are public on-chain) returns the
 *                     recorded outcome; duplicates arriving mid-mining
 *                     await the shared settlement promise.
 *   GET  /supported → the kinds this deployment can actually settle (one
 *                     network × `exact`) plus the relayer signer map.
 *
 * Request envelope (both POSTs): `{x402Version, paymentPayload,
 * paymentRequirements}`. Responses are always HTTP 200 with the spec-typed
 * body — domain failures surface as `isValid:false` / `success:false` with
 * a §9 reason code, never as bespoke strings.
 *
 * The deployment is env-configured (single network), so verify/settle run
 * with the `networkConfig` override instead of the NETWORKS registry.
 *
 * Failure semantics inherited from the core: a settle whose chain write
 * fails AFTER the consuming verify leaves the replay record in place — the
 * payer must mint a fresh nonce to retry (see replay-store.ts contract).
 */

import { createHash } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { buildChain } from './chain.js';
import {
  NonceStore,
  scrubSecrets,
  settleOnChain,
  verifyEip3009Authorization,
} from './eip3009/index.js';
import type { OpaqueRelayerKey } from './eip3009/index.js';
import type {
  NetworkConfig,
  PaymentPayload,
  PaymentRequirements,
  PublicClientLike,
  SettleReason,
  VerifyReason,
} from './eip3009/index.js';

/** Spec §9 error reasons (x402-specification-v1.md). */
export type X402ErrorReason =
  | 'insufficient_funds'
  | 'invalid_exact_evm_payload_authorization_valid_after'
  | 'invalid_exact_evm_payload_authorization_valid_before'
  | 'invalid_exact_evm_payload_authorization_value'
  | 'invalid_exact_evm_payload_signature'
  | 'invalid_exact_evm_payload_recipient_mismatch'
  | 'invalid_network'
  | 'invalid_payload'
  | 'invalid_payment_requirements'
  | 'invalid_scheme'
  | 'unsupported_scheme'
  | 'invalid_x402_version'
  | 'invalid_transaction_state'
  | 'unexpected_verify_error'
  | 'unexpected_settle_error';

export type X402VerifyResponse =
  | { isValid: true; payer: `0x${string}` }
  | { isValid: false; invalidReason: X402ErrorReason; payer?: `0x${string}` };

export type X402SettleResponse =
  | { success: true; payer: `0x${string}`; transaction: `0x${string}`; network: string }
  | {
      success: false;
      errorReason: X402ErrorReason;
      payer?: `0x${string}`;
      transaction: '';
      network: string;
    };

export interface X402SupportedResponse {
  kinds: Array<{ x402Version: 1; scheme: 'exact'; network: string }>;
  /** U1 extension: CAIP-2 network id → relayer signer address. */
  signers: Record<string, `0x${string}`>;
}

const VERIFY_REASON_MAP: Record<VerifyReason, X402ErrorReason> = {
  invalid_signature: 'invalid_exact_evm_payload_signature',
  to_mismatch: 'invalid_exact_evm_payload_recipient_mismatch',
  insufficient_amount: 'invalid_exact_evm_payload_authorization_value',
  authorization_expired: 'invalid_exact_evm_payload_authorization_valid_before',
  authorization_not_yet_valid: 'invalid_exact_evm_payload_authorization_valid_after',
  network_mismatch: 'invalid_network',
  nonce_already_used: 'invalid_transaction_state',
};

// Chain-write failures where the transaction state (not the operator's
// infrastructure) is the problem map to invalid_transaction_state; RPC and
// relayer-side failures are unexpected_settle_error.
const SETTLE_REASON_MAP: Record<SettleReason, X402ErrorReason> = {
  gas_estimate_revert: 'invalid_transaction_state',
  receipt_reverted: 'invalid_transaction_state',
  authorization_already_used_onchain: 'invalid_transaction_state',
  rpc_timeout: 'unexpected_settle_error',
  rpc_5xx: 'unexpected_settle_error',
  mine_timeout: 'unexpected_settle_error',
  relayer_no_balance: 'unexpected_settle_error',
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const UINT_RE = /^[0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type EnvelopeResult =
  | { ok: true; payload: PaymentPayload; requirements: PaymentRequirements }
  | { ok: false; reason: X402ErrorReason; payer?: `0x${string}` | undefined };

/**
 * Fire-and-forget event hook for the money path. Fields are passed through
 * `scrubSecrets` before emission and a throwing logger never breaks a
 * request. Deliberate deviation from the middleware D18 catalog: payer
 * addresses are emitted raw (they are public calldata the moment the
 * settlement lands) and errors are reduced to name+message — key material
 * is what must never leak, and scrubSecrets enforces that.
 */
export type X402Logger = (event: string, fields: Record<string, unknown>) => void;

export interface X402FacilitatorOptions {
  /** The single network this deployment settles, built from env config. */
  network: NetworkConfig;
  relayerKey: OpaqueRelayerKey;
  /** Relayer signer address, derived once at startup by the CLI. */
  relayerAddress: `0x${string}`;
  /** Injectable for tests; defaults to a viem client on network.rpcUrl. */
  publicClient?: PublicClientLike;
  log?: X402Logger;
  /** Injectable for tests; default to the eip3009 core functions. */
  deps?: {
    verify?: typeof verifyEip3009Authorization;
    settle?: typeof settleOnChain;
  };
}

/**
 * Authorizations may not be valid further into the future than this.
 * Bounds NonceStore growth (an entry lives until `validBefore`) and
 * rejects the `Number(validBefore) -> Infinity` degenerate case.
 */
const MAX_AUTHORIZATION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** #settled sweep only bothers walking the map once it reaches this size. */
const SETTLED_SWEEP_THRESHOLD = 1024;

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

interface SettledEntry {
  validBeforeMs: number;
  /** Set once the consuming verify passes; burned entries are terminal records. */
  nonceBurned: boolean;
  result: Promise<X402SettleResponse>;
}

export class X402Facilitator {
  readonly #network: NetworkConfig;
  readonly #relayerKey: OpaqueRelayerKey;
  readonly #relayerAddress: `0x${string}`;
  readonly #publicClient: PublicClientLike;
  readonly #nonceStore = new NonceStore();
  readonly #verify: typeof verifyEip3009Authorization;
  readonly #settle: typeof settleOnChain;
  readonly #logger: X402Logger | undefined;
  /** Settlement records keyed by sha256 of the exact envelope fingerprint. */
  readonly #settled = new Map<string, SettledEntry>();
  #lastSweepMs = 0;

  constructor(opts: X402FacilitatorOptions) {
    this.#logger = opts.log;
    this.#network = opts.network;
    this.#relayerKey = opts.relayerKey;
    this.#relayerAddress = opts.relayerAddress;
    this.#publicClient =
      opts.publicClient ??
      (createPublicClient({
        chain: buildChain(opts.network.chainId, opts.network.rpcUrl),
        transport: http(opts.network.rpcUrl),
      }) as unknown as PublicClientLike);
    this.#verify = opts.deps?.verify ?? verifyEip3009Authorization;
    this.#settle = opts.deps?.settle ?? settleOnChain;
  }

  supported(): X402SupportedResponse {
    return {
      kinds: [{ x402Version: 1, scheme: 'exact', network: this.#network.id }],
      signers: { [this.#network.id]: this.#relayerAddress },
    };
  }

  async verify(body: unknown): Promise<X402VerifyResponse> {
    const envelope = this.#decodeEnvelope(body);
    if (!envelope.ok) {
      return { isValid: false, invalidReason: envelope.reason, ...payerField(envelope.payer) };
    }
    const payer = envelope.payload.payload.authorization.from;
    const windowReason = this.#checkValidityWindow(
      envelope.payload.payload.authorization.validBefore,
    );
    if (windowReason !== undefined) {
      return { isValid: false, invalidReason: windowReason, payer };
    }
    let result;
    try {
      result = await this.#verify(envelope.payload, this.#verifyOptions(envelope, false));
    } catch (err) {
      this.#log('x402_verify_error', { payer, error: describeError(err) });
      return { isValid: false, invalidReason: 'unexpected_verify_error', payer };
    }
    if (!result.ok) {
      return { isValid: false, invalidReason: VERIFY_REASON_MAP[result.reason], payer };
    }
    // Payer-balance pre-check: the canonical `insufficient_funds` meaning.
    // Advisory — an unreadable balance never blocks verification (settlement
    // is the real gate; the transfer reverts on-chain for a broke payer).
    try {
      const balance = await this.#publicClient.readContract({
        address: this.#network.usdcAddress,
        abi: BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [result.recoveredFrom],
      });
      if (
        typeof balance === 'bigint' &&
        balance < BigInt(envelope.payload.payload.authorization.value)
      ) {
        return { isValid: false, invalidReason: 'insufficient_funds', payer };
      }
    } catch {
      // Advisory read failed; fall through to the signature verdict.
    }
    return { isValid: true, payer: result.recoveredFrom };
  }

  async settle(body: unknown): Promise<X402SettleResponse> {
    const network = this.#network.id;
    const envelope = this.#decodeEnvelope(body);
    if (!envelope.ok) {
      return {
        success: false,
        errorReason: envelope.reason,
        transaction: '',
        network,
        ...payerField(envelope.payer),
      };
    }
    const authorization = envelope.payload.payload.authorization;
    const payer = authorization.from;
    const windowReason = this.#checkValidityWindow(authorization.validBefore);
    if (windowReason !== undefined) {
      return { success: false, errorReason: windowReason, transaction: '', network, payer };
    }

    this.#sweepSettled();

    // Idempotency: keyed by a digest of the EXACT envelope. Keying by
    // (from, nonce) would be a payment bypass — both become public
    // on-chain data at settlement — and even a fingerprint-guarded
    // (from, nonce) key leaves a record-loss path where a forged in-flight
    // entry forces a legitimate settle to run unrecorded. Keyed by
    // envelope digest, every distinct envelope gets its own record: exact
    // duplicates share the settlement PROMISE (a duplicate arriving while
    // the original is still mining awaits the real outcome), and any
    // (from, nonce) reuse across different envelopes is adjudicated by the
    // consuming verify's synchronous nonce check, never by this map.
    const key = createHash('sha256').update(fingerprintEnvelope(envelope)).digest('hex');
    const existing = this.#settled.get(key);
    if (existing !== undefined) {
      // Expiry is enforced at lookup, not only by the sweep, so replay
      // semantics do not flip at the sweep threshold: once the
      // authorization expires the record is gone and the verify path
      // answers (authorization_expired), same as after a sweep or restart.
      if (existing.validBeforeMs > Date.now()) return existing.result;
      this.#settled.delete(key);
    }

    const entry: SettledEntry = {
      validBeforeMs: Number(authorization.validBefore) * 1000,
      nonceBurned: false,
      result: Promise.resolve() as unknown as Promise<X402SettleResponse>,
    };
    entry.result = this.#attemptSettle(envelope, network, payer, entry);
    this.#settled.set(key, entry);
    const response = await entry.result;
    if (!entry.nonceBurned && this.#settled.get(key) === entry) {
      // Verify-stage rejection: this attempt committed nothing — drop the
      // record so the map holds only settlements that burned the nonce.
      this.#settled.delete(key);
    }
    return response;
  }

  /**
   * Consuming verify, then the on-chain write. Never throws. The nonce is
   * burned inside the verify's synchronous checkAndInsert, so two
   * concurrent attempts can never both reach the chain write — the loser
   * fails with nonce_already_used before any transaction is broadcast.
   */
  async #attemptSettle(
    envelope: Extract<EnvelopeResult, { ok: true }>,
    network: string,
    payer: `0x${string}`,
    entry: SettledEntry | undefined,
  ): Promise<X402SettleResponse> {
    let verifyResult;
    try {
      verifyResult = await this.#verify(envelope.payload, this.#verifyOptions(envelope, true));
    } catch (err) {
      this.#log('x402_settle_error', { payer, stage: 'verify', error: describeError(err) });
      return {
        success: false,
        errorReason: 'unexpected_settle_error',
        transaction: '',
        network,
        payer,
      };
    }
    if (!verifyResult.ok) {
      return {
        success: false,
        errorReason: VERIFY_REASON_MAP[verifyResult.reason],
        transaction: '',
        network,
        payer,
      };
    }
    if (entry !== undefined) entry.nonceBurned = true;

    let settleResult;
    try {
      settleResult = await this.#settle(envelope.payload, verifyResult.recoveredFrom, {
        network: this.#network.id,
        networkConfig: this.#network,
        relayerKey: this.#relayerKey,
        publicClient: this.#publicClient,
      });
    } catch (err) {
      // NetworkMismatchError (chainId pin) or an unclassified throw.
      this.#log('x402_settle_error', { payer, stage: 'chain', error: describeError(err) });
      return {
        success: false,
        errorReason: 'unexpected_settle_error',
        transaction: '',
        network,
        payer,
      };
    }
    if (!settleResult.ok) {
      this.#log('x402_settle_failed', { payer, reason: settleResult.reason });
      return {
        success: false,
        errorReason: SETTLE_REASON_MAP[settleResult.reason],
        transaction: '',
        network,
        payer,
      };
    }
    this.#log('x402_settled', { payer: settleResult.payer, transaction: settleResult.txHash });
    return {
      success: true,
      payer: settleResult.payer,
      transaction: settleResult.txHash,
      network,
    };
  }

  /**
   * Far-future (or non-numeric-overflow) validBefore values are rejected:
   * a replay-store entry lives until validBefore, so an unbounded window
   * lets an API-key holder park entries that never expire.
   */
  #checkValidityWindow(validBefore: string): X402ErrorReason | undefined {
    const validBeforeMs = Number(validBefore) * 1000;
    if (
      !Number.isFinite(validBeforeMs) ||
      validBeforeMs > Date.now() + MAX_AUTHORIZATION_VALIDITY_MS
    ) {
      return 'invalid_exact_evm_payload_authorization_valid_before';
    }
    return undefined;
  }

  /** Drop recorded settlements whose authorization has expired — a replay
   * after that degrades to invalid_transaction_state, and the on-chain
   * authorization-already-used revert remains the double-charge backstop.
   * Size- AND time-gated so a large mostly-live map is not walked on
   * every settle. */
  #sweepSettled(): void {
    if (this.#settled.size < SETTLED_SWEEP_THRESHOLD) return;
    const now = Date.now();
    if (now - this.#lastSweepMs < 60_000) return;
    this.#lastSweepMs = now;
    for (const [key, entry] of this.#settled) {
      if (entry.validBeforeMs <= now) this.#settled.delete(key);
    }
  }

  #log(event: string, fields: Record<string, unknown>): void {
    if (this.#logger === undefined) return;
    try {
      this.#logger(event, scrubSecrets(fields) as Record<string, unknown>);
    } catch {
      // Fire-and-forget: a broken logger never blocks the money path.
    }
  }

  #verifyOptions(
    envelope: Extract<EnvelopeResult, { ok: true }>,
    consumeNonce: boolean,
  ): Parameters<typeof verifyEip3009Authorization>[1] {
    return {
      expectedVaultAddress: envelope.requirements.payTo,
      expectedNetwork: envelope.requirements.network,
      maxAmountRequired: BigInt(envelope.requirements.maxAmountRequired),
      publicClient: this.#publicClient,
      nonceStore: this.#nonceStore,
      networkConfig: this.#network,
      consumeNonce,
    };
  }

  #decodeEnvelope(body: unknown): EnvelopeResult {
    if (!isRecord(body)) return { ok: false, reason: 'invalid_payload' };
    if (body['x402Version'] !== 1) return { ok: false, reason: 'invalid_x402_version' };
    const rawPayload = body['paymentPayload'];
    const rawRequirements = body['paymentRequirements'];
    if (!isRecord(rawPayload)) return { ok: false, reason: 'invalid_payload' };
    if (!isRecord(rawRequirements)) return { ok: false, reason: 'invalid_payment_requirements' };

    // Payment payload shape. Pull the claimed payer as early as possible so
    // even shape-level rejections can carry it (spec examples include payer
    // on error responses).
    const inner = rawPayload['payload'];
    const authorization = isRecord(inner) ? inner['authorization'] : undefined;
    const claimedFrom =
      isRecord(authorization) &&
      typeof authorization['from'] === 'string' &&
      ADDRESS_RE.test(authorization['from'])
        ? (authorization['from'] as `0x${string}`)
        : undefined;

    if (rawPayload['x402Version'] !== 1)
      return { ok: false, reason: 'invalid_x402_version', payer: claimedFrom };
    if (rawPayload['scheme'] !== 'exact')
      return { ok: false, reason: 'invalid_scheme', payer: claimedFrom };
    if (typeof rawPayload['network'] !== 'string' || rawPayload['network'].length === 0)
      return { ok: false, reason: 'invalid_payload', payer: claimedFrom };
    if (
      !isRecord(inner) ||
      typeof inner['signature'] !== 'string' ||
      !SIGNATURE_RE.test(inner['signature']) ||
      !isRecord(authorization) ||
      claimedFrom === undefined ||
      typeof authorization['to'] !== 'string' ||
      !ADDRESS_RE.test(authorization['to']) ||
      typeof authorization['value'] !== 'string' ||
      !UINT_RE.test(authorization['value']) ||
      typeof authorization['validAfter'] !== 'string' ||
      !UINT_RE.test(authorization['validAfter']) ||
      typeof authorization['validBefore'] !== 'string' ||
      !UINT_RE.test(authorization['validBefore']) ||
      typeof authorization['nonce'] !== 'string' ||
      !BYTES32_RE.test(authorization['nonce'])
    ) {
      return { ok: false, reason: 'invalid_payload', payer: claimedFrom };
    }

    // Payment requirements: structural checks, then deployment fit.
    if (rawRequirements['scheme'] !== 'exact')
      return { ok: false, reason: 'unsupported_scheme', payer: claimedFrom };
    const reqNetwork = rawRequirements['network'];
    if (typeof reqNetwork !== 'string' || reqNetwork.length === 0)
      return { ok: false, reason: 'invalid_payment_requirements', payer: claimedFrom };
    if (reqNetwork !== this.#network.id && reqNetwork !== this.#network.alias)
      return { ok: false, reason: 'invalid_network', payer: claimedFrom };
    if (
      typeof rawRequirements['payTo'] !== 'string' ||
      !ADDRESS_RE.test(rawRequirements['payTo']) ||
      typeof rawRequirements['maxAmountRequired'] !== 'string' ||
      !UINT_RE.test(rawRequirements['maxAmountRequired'])
    ) {
      return { ok: false, reason: 'invalid_payment_requirements', payer: claimedFrom };
    }
    const asset = rawRequirements['asset'];
    if (
      typeof asset !== 'string' ||
      asset.toLowerCase() !== this.#network.usdcAddress.toLowerCase()
    ) {
      return { ok: false, reason: 'invalid_payment_requirements', payer: claimedFrom };
    }

    return {
      ok: true,
      payload: rawPayload as unknown as PaymentPayload,
      requirements: rawRequirements as unknown as PaymentRequirements,
    };
  }
}

function payerField(payer: `0x${string}` | undefined): { payer?: `0x${string}` } {
  return payer === undefined ? {} : { payer };
}

/**
 * One exact envelope, one string. Every field is regex-validated by the
 * decoder before this runs, so `|` cannot occur inside a component and the
 * join is unambiguous. Addresses are lowercased; the signature binds the
 * authorization content, and payTo/amount/asset/network bind the
 * requirements the settlement was recorded against.
 */
function fingerprintEnvelope(envelope: Extract<EnvelopeResult, { ok: true }>): string {
  const { signature, authorization } = envelope.payload.payload;
  const requirements = envelope.requirements;
  return [
    signature.toLowerCase(),
    authorization.from.toLowerCase(),
    authorization.to.toLowerCase(),
    authorization.value,
    authorization.validAfter,
    authorization.validBefore,
    authorization.nonce.toLowerCase(),
    envelope.payload.network,
    requirements.payTo.toLowerCase(),
    requirements.maxAmountRequired,
    requirements.asset.toLowerCase(),
    requirements.network,
  ].join('|');
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
