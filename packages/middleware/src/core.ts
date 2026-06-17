/**
 * Core orchestrator — framework-agnostic paywall pipeline.
 *
 * Implements Solution "How it works" steps 7a–7g end-to-end. The single
 * entry point `paywall(req, opts)` is consumed by both the Node http
 * adapter and the Fastify adapter (per D6).
 *
 * Ownership boundaries (per systemic-fixes §5 and addendum §2):
 *
 *   - `core.ts` owns the per-network viem `PublicClient` cache (lazy init,
 *     concurrency-safe via in-flight Promise dedup).
 *   - `core.ts` owns the process-singleton `NonceStore` (module-scope; the
 *     same instance is observable across both adapters).
 *   - `core.ts` owns the per-network `FactoryStateCache` (TTL 5 s, with
 *     in-flight refresh dedup to avoid cache-stampede storms).
 *   - `core.ts` does NOT create or own `WalletClient` — that lives in
 *     `settle.ts`.
 *   - `core.ts` does NOT extract the underlying key from `OpaqueRelayerKey`.
 *     The wrapper instance is held opaque and passed through to `settle.ts`
 *     as a function argument. `settle.ts` is the only consumer that
 *     extracts via the private symbol.
 *
 *   - `core.ts` is the SINGLE owner of `logger.securityEvent(...)` emission
 *     (addendum §2). `verify.ts` and `settle.ts` do NOT import the logger
 *     and do NOT emit events. They return classified results; `core.ts`
 *     maps each result to the corresponding D18 event at the policy
 *     enforcement point. Emission is fire-and-forget — a throwing logger
 *     never blocks the request path.
 *
 *   - The D14 startup chainId pin lives in `settle.ts` (the first
 *     writeContract caller per request). When `settle.ts` throws
 *     `NetworkMismatchError`, `core.ts` catches it, emits `chain_id_mismatch`
 *     and returns 402 `settlement_failed { reason: 'internal_error' }`.
 *
 * Hash helpers (`payerHash`, `developerEoaHash`, `nonceHash`) all return a
 * canonical 10-character string: `'0x' + keccak256(input).slice(2, 10)` —
 * an `0x` prefix plus 8 hex chars. This is the only form used in event
 * payloads — no raw address, no raw nonce.
 */

import { createPublicClient, http, keccak256 } from 'viem';
import type { PublicClient } from 'viem';
import {
  decodeXPayment,
  encodeXPaymentResponse,
  MalformedPaymentHeaderError,
  parseUsdPrice,
} from './x402.js';
import type { MalformedHeaderDetail } from './x402.js';
import { NETWORKS } from './networks.js';
import { NonceStore } from './replay-store.js';
import { scrubSecrets } from './relayer-key.js';
import type { OpaqueRelayerKey } from './relayer-key.js';
import { verifyEip3009Authorization } from './verify.js';
import { settleOnChain, NetworkMismatchError } from './settle.js';
import type {
  NetworkConfig,
  PaymentPayload,
  PaymentRequirements,
  PaywallConfig,
  SecurityEventCatalog,
  SecurityEventName,
} from './types.js';

// ─── Internal types ──────────────────────────────────────────────────────────
//
// `PaywallRequest`, `PaywallCoreOptions`, and `PaywallResult` are adapter
// infrastructure: the adapters in `./adapters/*` consume them, but they are
// NOT part of the public npm package surface. The public `SecurityLogger`,
// `SecurityEventCatalog`, and `SecurityEventName` types live in `types.ts`
// (re-exported by `index.ts`).

export interface PaywallRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
}

/**
 * Options carried into `core.paywall`. Identical to `PaywallConfig` from
 * `types.ts` — the adapter and core both accept the public config shape
 * directly. `logger` lives on `PaywallConfig` itself so integrators wire it
 * through a single options object.
 */
export type PaywallCoreOptions = PaywallConfig;

export type PaywallResult =
  | {
      kind: '402';
      status: 400 | 402;
      headers: Record<string, string>;
      body: { x402Version: 1; accepts: PaymentRequirements[]; error: string; [k: string]: unknown };
    }
  | { kind: 'passthrough'; responseHeaders: { 'X-PAYMENT-RESPONSE': string } };

// ─── Module-scope shared resources ───────────────────────────────────────────
//
// Per systemic-fixes §5: NonceStore is process-singleton, observable across
// both adapters in the same process. PublicClient and FactoryStateCache are
// per-network maps that survive across requests.

const nonceStore: NonceStore = new NonceStore();

const PUBLIC_CLIENTS: Map<string, PublicClient> = new Map();
const PUBLIC_CLIENT_INFLIGHT: Map<string, Promise<PublicClient>> = new Map();

interface FactoryStateEntry {
  paused: boolean;
  vaults: Map<string, `0x${string}`>;
  fetchedAt: number;
}

const FACTORY_STATE_CACHE: Map<string, FactoryStateEntry> = new Map();
const FACTORY_STATE_INFLIGHT: Map<string, Promise<FactoryStateEntry>> = new Map();
const VAULT_LOOKUP_INFLIGHT: Map<string, Promise<`0x${string}`>> = new Map();

const FACTORY_STATE_TTL_MS = 5_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'vaults',
    stateMutability: 'view',
    inputs: [{ name: 'developer', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/**
 * Test-only: reset module-scope caches so per-test setup runs from a
 * deterministic clean slate. Not exported from `index.ts`.
 */
export function __resetCoreCachesForTests(): void {
  PUBLIC_CLIENTS.clear();
  PUBLIC_CLIENT_INFLIGHT.clear();
  FACTORY_STATE_CACHE.clear();
  FACTORY_STATE_INFLIGHT.clear();
  VAULT_LOOKUP_INFLIGHT.clear();
}

/**
 * Test-only: surfaces the module-scope NonceStore so the cross-adapter
 * replay-rejection test in Task 10 can assert identity. Not exported from
 * `index.ts`.
 */
export function __getNonceStoreForTests(): NonceStore {
  return nonceStore;
}

// ─── Hash helpers (D18 event payloads — 10-char canonical form) ──────────────

/**
 * Canonical short-hash form for D18 event payloads (per addendum §5).
 * Returns `'0x' + 8 hex chars` (10-char total). Used uniformly so logger
 * payloads never contain a raw address or nonce.
 */
export function shortHash(input: `0x${string}`): string {
  return '0x' + keccak256(input).slice(2, 10);
}

export const payerHash = shortHash;
export const developerEoaHash = shortHash;
export const nonceHash = shortHash;

// ─── PublicClient lazy init (per-network, concurrency-safe) ──────────────────

function resolveRpcUrl(opts: PaywallCoreOptions, network: NetworkConfig): string {
  return opts.facilitator.rpcUrl ?? network.rpcUrl;
}

async function getPublicClient(
  opts: PaywallCoreOptions,
  network: NetworkConfig,
): Promise<PublicClient> {
  const cacheKey = `${network.id}|${resolveRpcUrl(opts, network)}`;
  const cached = PUBLIC_CLIENTS.get(cacheKey);
  if (cached !== undefined) return cached;
  const inflight = PUBLIC_CLIENT_INFLIGHT.get(cacheKey);
  if (inflight !== undefined) return inflight;
  const build = (async () => {
    const client = createPublicClient({
      transport: http(resolveRpcUrl(opts, network)),
    }) as PublicClient;
    PUBLIC_CLIENTS.set(cacheKey, client);
    PUBLIC_CLIENT_INFLIGHT.delete(cacheKey);
    return client;
  })();
  PUBLIC_CLIENT_INFLIGHT.set(cacheKey, build);
  return build;
}

// ─── Factory state cache (5 s TTL, refresh dedup) ────────────────────────────

interface FactoryReadResult {
  entry: FactoryStateEntry;
  servedStale: boolean;
}

async function readFactoryState(
  network: NetworkConfig,
  publicClient: PublicClient,
): Promise<FactoryReadResult> {
  const cached = FACTORY_STATE_CACHE.get(network.id);
  const now = Date.now();
  if (cached !== undefined && now - cached.fetchedAt < FACTORY_STATE_TTL_MS) {
    return { entry: cached, servedStale: false };
  }
  const inflight = FACTORY_STATE_INFLIGHT.get(network.id);
  if (inflight !== undefined) {
    const entry = await inflight;
    return { entry, servedStale: false };
  }
  const refresh = (async (): Promise<FactoryStateEntry> => {
    try {
      const paused = (await publicClient.readContract({
        address: network.factoryAddress,
        abi: FACTORY_ABI,
        functionName: 'paused',
      })) as boolean;
      const next: FactoryStateEntry = {
        paused,
        vaults: cached?.vaults !== undefined ? new Map(cached.vaults) : new Map(),
        fetchedAt: Date.now(),
      };
      FACTORY_STATE_CACHE.set(network.id, next);
      return next;
    } finally {
      FACTORY_STATE_INFLIGHT.delete(network.id);
    }
  })();
  FACTORY_STATE_INFLIGHT.set(network.id, refresh);
  try {
    const entry = await refresh;
    return { entry, servedStale: false };
  } catch (err) {
    if (cached !== undefined) {
      // Last-good fallback — only when the cached entry is still
      // observable. Mark it stale so the caller can decide whether to
      // accept (paused/vault checks accept; we only refuse if there is
      // nothing in the cache at all).
      return { entry: cached, servedStale: true };
    }
    throw err;
  }
}

async function readVaultAddress(
  network: NetworkConfig,
  publicClient: PublicClient,
  state: FactoryStateEntry,
  developerEoa: `0x${string}`,
): Promise<`0x${string}`> {
  const key = developerEoa.toLowerCase();
  // Once non-zero, a deployed vault address is final (factory deploys are
  // immutable per D3). Cache forever; re-fetch only while still 0x0.
  const cached = state.vaults.get(key);
  if (cached !== undefined && cached !== ZERO_ADDRESS) return cached;
  const inflightKey = `${network.id}|${key}`;
  const inflight = VAULT_LOOKUP_INFLIGHT.get(inflightKey);
  if (inflight !== undefined) return inflight;
  const fetch = (async (): Promise<`0x${string}`> => {
    try {
      const vault = (await publicClient.readContract({
        address: network.factoryAddress,
        abi: FACTORY_ABI,
        functionName: 'vaults',
        args: [developerEoa],
      })) as `0x${string}`;
      state.vaults.set(key, vault);
      return vault;
    } finally {
      VAULT_LOOKUP_INFLIGHT.delete(inflightKey);
    }
  })();
  VAULT_LOOKUP_INFLIGHT.set(inflightKey, fetch);
  return fetch;
}

// ─── 402 body builders ───────────────────────────────────────────────────────

function buildPaymentRequirements(
  opts: PaywallCoreOptions,
  network: NetworkConfig,
  payTo: `0x${string}`,
  maxAmountRequired: string,
  req: PaywallRequest,
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: network.id,
    maxAmountRequired,
    resource: opts.resource ?? req.url ?? '',
    description: opts.description ?? '',
    mimeType: opts.mimeType ?? 'application/json',
    payTo,
    maxTimeoutSeconds: 60,
    asset: network.usdcAddress,
    extra: {
      assetTransferMethod: 'eip3009',
      name: network.usdcEip712Name,
      version: network.usdcEip712Version,
    },
  };
}

function build402(
  status: 400 | 402,
  requirements: PaymentRequirements | null,
  error: string,
  extra?: Record<string, unknown>,
): PaywallResult {
  const accepts = requirements === null ? [] : [requirements];
  const body: {
    x402Version: 1;
    accepts: PaymentRequirements[];
    error: string;
    [k: string]: unknown;
  } = { x402Version: 1, accepts, error };
  if (extra !== undefined) {
    for (const [k, v] of Object.entries(extra)) body[k] = v;
  }
  return {
    kind: '402',
    status,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

// ─── Header lookup ───────────────────────────────────────────────────────────

function readHeader(req: PaywallRequest, name: string): string | undefined {
  const target = name.toLowerCase();
  // Node's IncomingMessage already lowercases header names; Fastify likewise.
  // We still tolerate mixed-case (e.g. a hand-rolled adapter) by iterating.
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

// ─── Logger emit helper (single owner per addendum §2) ───────────────────────

/**
 * Fire-and-forget event emit with per-call try/catch so a throw on event N
 * does not block events N+1 within the same handler. Default to no-op when
 * `opts.logger` is undefined — the helper short-circuits without invoking
 * `scrubSecrets`, so the unconfigured path produces no work.
 */
function emit<N extends SecurityEventName>(
  opts: PaywallCoreOptions,
  name: N,
  payload: SecurityEventCatalog[N],
): void {
  if (opts.logger === undefined) return;
  try {
    const scrubbed = scrubSecrets(payload) as SecurityEventCatalog[N];
    opts.logger.securityEvent(name, scrubbed);
  } catch {
    // Swallow: a misconfigured logger must not block the request path.
  }
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Orchestrate the Solution "How it works" pipeline for a single request.
 * Returns a discriminated union the adapters translate to HTTP.
 */
export async function paywall(
  req: PaywallRequest,
  opts: PaywallCoreOptions,
): Promise<PaywallResult> {
  const network: NetworkConfig | undefined = (
    NETWORKS as Record<string, NetworkConfig | undefined>
  )[opts.network];
  if (network === undefined) {
    // Configuration error surfaced as a 402 internal-error — the integrator
    // should see this in the first request after misconfiguration. We do
    // NOT throw here: a per-request 402 keeps the integrator's service
    // responsive while alerting via the security log.
    emit(opts, 'chain_id_mismatch', { expected: 0, actual: 0, network: opts.network });
    return build402(402, null, 'settlement_failed', { reason: 'internal_error' });
  }

  const publicClient = await getPublicClient(opts, network);

  // The 402 challenge requires the payTo address (= developer's vault). For
  // the no-X-PAYMENT branch we still need it. Read from the factory cache
  // — same source as the on-the-fly check below. If the cache lookup
  // fails on the no-header branch, we still emit a 402 challenge with
  // payTo === 0x0; the agent will retry once the vault is deployed.
  let factoryState: FactoryStateEntry | undefined;
  let payTo: `0x${string}` = ZERO_ADDRESS;
  try {
    const read = await readFactoryState(network, publicClient);
    factoryState = read.entry;
    payTo = await readVaultAddress(network, publicClient, factoryState, opts.developerEoa);
  } catch {
    // Defer error handling to the per-step branches below; if the request
    // has no X-PAYMENT header we still return a useful 402 challenge.
  }

  const maxAmountRequiredBig = parseUsdPrice(opts.price);
  const maxAmountRequired = maxAmountRequiredBig.toString();
  const requirements = buildPaymentRequirements(opts, network, payTo, maxAmountRequired, req);

  // ─── 7a: read X-PAYMENT, enforce size cap ────────────────────────────────
  const headerValue = readHeader(req, 'x-payment');
  if (headerValue === undefined) {
    return build402(402, requirements, 'payment_required');
  }
  const headerBytes = Buffer.byteLength(headerValue, 'utf8');
  if (headerBytes > 4096) {
    emit(opts, 'header_too_large', { size: headerBytes });
    return build402(400, requirements, 'header_too_large');
  }

  // ─── 7b: decode ──────────────────────────────────────────────────────────
  let payload: PaymentPayload;
  try {
    payload = decodeXPayment(headerValue);
  } catch (err) {
    if (err instanceof MalformedPaymentHeaderError) {
      const phase = err.detail.phase as MalformedHeaderDetail['phase'];
      if (phase === 'size') {
        emit(opts, 'header_too_large', { size: headerBytes });
        return build402(400, requirements, 'header_too_large');
      }
      emit(opts, 'malformed_header', { phase });
      return build402(400, requirements, 'malformed_payment_header');
    }
    throw err;
  }

  // ─── 7c: verify ──────────────────────────────────────────────────────────
  const verifyResult = await verifyEip3009Authorization(payload, {
    expectedVaultAddress: payTo,
    expectedNetwork: opts.network,
    maxAmountRequired: maxAmountRequiredBig,
    publicClient,
    nonceStore,
    nowMs: Date.now(),
  });
  if (!verifyResult.ok) {
    const fromAddr = payload.payload.authorization.from;
    const reason = verifyResult.reason;
    const payerH = payerHash(fromAddr);
    switch (reason) {
      case 'invalid_signature':
        emit(opts, 'signature_invalid', { payerHash: payerH, network: network.id });
        return build402(402, requirements, 'invalid_signature');
      case 'nonce_already_used':
        emit(opts, 'nonce_replay', {
          payerHash: payerH,
          nonceHash: nonceHash(payload.payload.authorization.nonce),
        });
        return build402(402, requirements, 'nonce_already_used');
      case 'authorization_expired':
        emit(opts, 'authorization_expired', { payerHash: payerH });
        return build402(402, requirements, 'authorization_expired');
      case 'authorization_not_yet_valid':
        emit(opts, 'authorization_not_yet_valid', { payerHash: payerH });
        return build402(402, requirements, 'authorization_not_yet_valid');
      case 'network_mismatch':
        emit(opts, 'network_mismatch', { expected: network.id, received: payload.network });
        return build402(402, requirements, 'network_mismatch');
      case 'to_mismatch':
        emit(opts, 'to_mismatch', { payerHash: payerH });
        return build402(402, requirements, 'to_mismatch');
      case 'insufficient_amount': {
        const received = payload.payload.authorization.value;
        emit(opts, 'insufficient_amount', {
          required: maxAmountRequired,
          received,
        });
        return build402(402, requirements, 'insufficient_amount', {
          required: maxAmountRequired,
          received,
        });
      }
    }
  }

  // ─── 7d: factory-state checks ────────────────────────────────────────────
  if (factoryState === undefined) {
    try {
      const read = await readFactoryState(network, publicClient);
      factoryState = read.entry;
      payTo = await readVaultAddress(network, publicClient, factoryState, opts.developerEoa);
    } catch {
      // Cache stale and refresh failed — surface as settlement_failed/rpc_5xx.
      emit(opts, 'settlement_failed', {
        payerHash: payerHash(verifyResult.recoveredFrom),
        reason: 'rpc_5xx',
      });
      return build402(402, requirements, 'settlement_failed', { reason: 'rpc_5xx' });
    }
  }
  if (factoryState.paused) {
    emit(opts, 'paused_request', { developerEoaHash: developerEoaHash(opts.developerEoa) });
    return build402(402, requirements, 'paused');
  }
  if (payTo === ZERO_ADDRESS) {
    emit(opts, 'vault_not_deployed', { developerEoaHash: developerEoaHash(opts.developerEoa) });
    return build402(402, requirements, 'vault_not_deployed');
  }

  // ─── 7e: settle ──────────────────────────────────────────────────────────
  // Use the cryptographically RECOVERED signer (EIP-712 ecrecover output from
  // verify.ts), not the claimed wire-format `authorization.from`. In the
  // happy path the two are equal (verify enforced that), but binding settle
  // and the X-PAYMENT-RESPONSE `payer` field to `recoveredFrom` keeps the
  // authenticated value as the single source of truth.
  const { recoveredFrom } = verifyResult;
  const payerH = payerHash(recoveredFrom);
  let settleResult;
  try {
    settleResult = await settleOnChain(payload, recoveredFrom, {
      network: opts.network,
      relayerKey: opts.facilitator.relayerKey as OpaqueRelayerKey,
      publicClient,
    });
  } catch (err) {
    if (err instanceof NetworkMismatchError) {
      emit(opts, 'chain_id_mismatch', {
        expected: err.expectedChainId,
        actual: err.observedChainId,
        network: network.id,
      });
      return build402(402, requirements, 'settlement_failed', { reason: 'internal_error' });
    }
    throw err;
  }
  if (!settleResult.ok) {
    const extra: { reason: string; txHash?: string } = { reason: settleResult.reason };
    emit(opts, 'settlement_failed', { payerHash: payerH, reason: settleResult.reason });
    return build402(402, requirements, 'settlement_failed', extra);
  }

  // ─── 7f + 7g: success ────────────────────────────────────────────────────
  const xPaymentResponse = encodeXPaymentResponse({
    success: true,
    transaction: settleResult.txHash,
    network: network.id,
    payer: recoveredFrom,
  });
  return {
    kind: 'passthrough',
    responseHeaders: { 'X-PAYMENT-RESPONSE': xPaymentResponse },
  };
}
