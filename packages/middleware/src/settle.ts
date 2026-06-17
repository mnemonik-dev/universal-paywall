/**
 * settleOnChain — relayer-signed `USDC.transferWithAuthorization` settler.
 *
 * Single-module responsibilities (per tech-spec D2 / D13 / D14 + systemic-fixes §5):
 *
 *   - Sole owner of the per-network viem `WalletClient` cache. The relayer
 *     EOA private key is extracted from `OpaqueRelayerKey` ONLY here, via the
 *     module-private `getRelayerKeySecret` symbol exported from
 *     `relayer-key.ts`. The raw key never escapes this module — not as a
 *     parameter, not as a return value, not in any error field.
 *
 *   - First-write-per-request chain ID pin (D14): on first use of a network,
 *     calls `publicClient.getChainId()` and asserts it equals
 *     `NETWORKS[network].chainId`. Mismatch throws `NetworkMismatchError`.
 *
 *   - Proactive `relayer_no_balance` check (systemic-fixes-3 §7): reads
 *     `USDC.balanceOf(relayer)` and short-circuits if the balance is strictly
 *     less than the module-level constant `MIN_RELAYER_USDC_BALANCE`. The
 *     constant is exported so tests reference the same identifier.
 *
 *   - `writeContract` → `transferWithAuthorization`, then await receipt with
 *     a 30 s timeout via the core-owned `publicClient`.
 *
 *   - Seven-way classifier mapping every conceivable failure into exactly
 *     one of the `SettleReason`s. The `authorization_already_used_onchain`
 *     classification uses **case-insensitive substring matching on
 *     `"authorization is used"`** in the decoded revert reason
 *     (systemic-fixes-3 §6). There is NO 4-byte selector — Circle's
 *     FiatTokenV2 reverts via a `require()` string. When the revert reason
 *     cannot be extracted, the classifier falls back to `receipt_reverted`
 *     rather than guessing.
 *
 *   - No SecurityLogger / event emission (systemic-fixes-3 §2). All event
 *     wiring lives in `core.ts`; this module only returns a classified
 *     `SettleResult`.
 *
 *   - No replay-store interaction. The replay-store entry inserted by
 *     `verify.ts` stays put on settle failure by structural enforcement
 *     (Risks row "Settlement failure mid-flight").
 */

import {
  BaseError,
  ContractFunctionExecutionError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
  createWalletClient,
  http,
  parseSignature,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Account, WalletClient } from 'viem';
import { NETWORKS } from './networks.js';
import { OpaqueRelayerKey, getRelayerKeySecret } from './relayer-key.js';
import type { NetworkConfig, PaymentPayload } from './types.js';

/**
 * Proactive relayer USDC balance threshold — strict less-than triggers
 * `relayer_no_balance` before any on-chain write. 1 USDC at 6 decimals.
 */
export const MIN_RELAYER_USDC_BALANCE = 1_000_000n;

export type SettleReason =
  | 'rpc_timeout'
  | 'rpc_5xx'
  | 'gas_estimate_revert'
  | 'mine_timeout'
  | 'receipt_reverted'
  | 'relayer_no_balance'
  | 'authorization_already_used_onchain';

export type SettleResult =
  | { ok: true; txHash: `0x${string}`; payer: `0x${string}` }
  | {
      ok: false;
      reason: SettleReason;
      details?: { gasEstimate?: bigint; balance?: bigint };
    };

export interface SettleOptions {
  network: string;
  relayerKey: OpaqueRelayerKey;
  /**
   * viem `PublicClient` owned by `core.ts`. Used for `getChainId`,
   * `readContract` (balanceOf), and `waitForTransactionReceipt`. Typed
   * structurally to avoid leaking viem generics into the public surface.
   */
  publicClient: PublicClientLike;
}

/**
 * Minimal structural slice of viem's PublicClient used here. Lets test
 * doubles pass without binding to viem's generic chain/transport types.
 */
export interface PublicClientLike {
  getChainId(): Promise<number>;
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    timeout: number;
  }): Promise<{ status: 'success' | 'reverted' }>;
}

export class NetworkMismatchError extends Error {
  override readonly name = 'NetworkMismatchError';
  readonly expectedChainId: number;
  readonly observedChainId: number;
  constructor(expectedChainId: number, observedChainId: number) {
    super(`Network mismatch: expected chainId=${expectedChainId}, observed=${observedChainId}`);
    this.expectedChainId = expectedChainId;
    this.observedChainId = observedChainId;
  }
}

// ─── Module-level cache (per-network WalletClient + chainId-pin flag) ─────────
//
// Per systemic-fixes §5, `settle.ts` is the sole owner of WalletClient
// creation. `PublicClient` is NOT cached here — it's owned by core.ts.
//
// On a race during cold-start init, both callers may build a wallet and
// each call getChainId once; the assertion is idempotent.

interface WalletCacheEntry {
  walletClient: WalletClient;
  account: Account;
  chainIdPinned: boolean;
}

const WALLET_CACHE = new Map<string, WalletCacheEntry>();

/**
 * Test-only: reset the per-network WalletClient cache so chainId-pin
 * tests can assert "first call" behaviour deterministically. Not exported
 * via index.ts.
 */
export function __resetSettleCacheForTests(): void {
  WALLET_CACHE.clear();
}

function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.startsWith('0x') ? raw.slice(2) : raw;
  return `0x${trimmed}` as `0x${string}`;
}

function buildWalletClient(network: NetworkConfig, relayerKey: OpaqueRelayerKey): WalletCacheEntry {
  // Sole extraction site per D13 + systemic-fixes §5. The raw key lives
  // inside this function's lexical scope and the viem account only — it
  // never crosses a parameter or return-value boundary.
  const raw = getRelayerKeySecret(relayerKey);
  const account = privateKeyToAccount(normalizePrivateKey(raw));
  const walletClient = createWalletClient({
    account,
    transport: http(network.rpcUrl),
  });
  return { walletClient, account, chainIdPinned: false };
}

// ─── ABI fragments ────────────────────────────────────────────────────────────
//
// Minimal USDC ABI subset: only the two functions this module calls.
// Keeping the slice narrow means there's no surface for accidental calls
// to other USDC methods.

const USDC_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// ─── Classifier ──────────────────────────────────────────────────────────────

const AUTH_ALREADY_USED_MARKER = 'authorization is used';

/**
 * Pull every plausible revert-reason carrier off a viem error chain and
 * stitch them into a single lowercase string. Substring match against
 * `AUTH_ALREADY_USED_MARKER` is the only allowed positive signal for the
 * `authorization_already_used_onchain` classification (systemic-fixes-3 §6).
 */
function extractRevertReasonString(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur === 'object') {
      const r = cur as Record<string, unknown>;
      if (typeof r['shortMessage'] === 'string') parts.push(r['shortMessage']);
      if (typeof r['message'] === 'string') parts.push(r['message']);
      if (typeof r['reason'] === 'string') parts.push(r['reason']);
      if (typeof r['details'] === 'string') parts.push(r['details']);
      if (Array.isArray(r['metaMessages'])) {
        for (const m of r['metaMessages']) {
          if (typeof m === 'string') parts.push(m);
        }
      }
      cur = r['cause'];
    } else {
      break;
    }
  }
  return parts.join(' ').toLowerCase();
}

function matchesAuthorizationAlreadyUsed(err: unknown): boolean {
  const joined = extractRevertReasonString(err);
  return joined.includes(AUTH_ALREADY_USED_MARKER);
}

function classifyWriteError(err: unknown): {
  reason: SettleReason;
  details?: { gasEstimate?: bigint; balance?: bigint };
} {
  // `WaitForTransactionReceiptTimeoutError` is checked BEFORE the generic
  // `TimeoutError`. The two are distinct viem classes and must not
  // collapse into the same branch (per task spec).
  if (err instanceof WaitForTransactionReceiptTimeoutError) {
    return { reason: 'mine_timeout' };
  }
  if (err instanceof TimeoutError) {
    return { reason: 'rpc_timeout' };
  }
  if (err instanceof HttpRequestError) {
    // Any HTTP-layer error from the RPC transport classifies as `rpc_5xx`
    // (the closest bucket in the seven-reason taxonomy). The previous
    // implementation collapsed non-5xx HttpRequestError into `rpc_timeout`,
    // which conflates rate-limit (429) and auth (401) with actual
    // timeouts — misleading for operators reading event logs.
    return { reason: 'rpc_5xx' };
  }
  if (err instanceof InsufficientFundsError) {
    return { reason: 'relayer_no_balance' };
  }
  if (err instanceof ContractFunctionExecutionError) {
    if (matchesAuthorizationAlreadyUsed(err)) {
      return { reason: 'authorization_already_used_onchain' };
    }
    // Reactive insufficient-funds: viem doesn't always wrap node errors in
    // `InsufficientFundsError` cleanly, so also probe the revert string.
    const joined = extractRevertReasonString(err);
    if (joined.includes('insufficient funds') || joined.includes('insufficient balance')) {
      return { reason: 'relayer_no_balance' };
    }
    return { reason: 'gas_estimate_revert' };
  }
  // Unknown error: probe the string for the only safe positive signal.
  if (matchesAuthorizationAlreadyUsed(err)) {
    return { reason: 'authorization_already_used_onchain' };
  }
  if (err instanceof BaseError) {
    return { reason: 'gas_estimate_revert' };
  }
  return { reason: 'receipt_reverted' };
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function settleOnChain(
  payload: PaymentPayload,
  recoveredFrom: `0x${string}`,
  opts: SettleOptions,
): Promise<SettleResult> {
  const network: NetworkConfig | undefined = (
    NETWORKS as Record<string, NetworkConfig | undefined>
  )[opts.network];
  if (network === undefined) {
    throw new Error(
      `settleOnChain: unknown network ${JSON.stringify(opts.network)} — not present in NETWORKS registry`,
    );
  }

  let entry = WALLET_CACHE.get(network.id);
  if (entry === undefined) {
    entry = buildWalletClient(network, opts.relayerKey);
    WALLET_CACHE.set(network.id, entry);
  }

  // Chain ID pin — D14. Run only on first use of this network per process;
  // a passing assertion is idempotent so race-y cold-starts are safe.
  if (!entry.chainIdPinned) {
    const observed = await opts.publicClient.getChainId();
    if (observed !== network.chainId) {
      throw new NetworkMismatchError(network.chainId, observed);
    }
    entry.chainIdPinned = true;
  }

  // Proactive relayer USDC balance check (systemic-fixes-3 §7).
  // Constant threshold — strict `<` triggers short-circuit.
  let balance: bigint;
  try {
    const raw = await opts.publicClient.readContract({
      address: network.usdcAddress,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [entry.account.address],
    });
    if (typeof raw !== 'bigint') {
      // Defensive: a misbehaving RPC / test double could return a
      // non-bigint here. We refuse to fall through with a numeric
      // value (BigInt-vs-Number comparisons would still work, but
      // any downstream `details: { balance }` field would leak the
      // wrong type). Classify as rpc_5xx — the data plane is broken.
      return { ok: false, reason: 'rpc_5xx' };
    }
    balance = raw;
  } catch (err) {
    const classified = classifyWriteError(err);
    return { ok: false, ...classified };
  }
  if (balance < MIN_RELAYER_USDC_BALANCE) {
    return {
      ok: false,
      reason: 'relayer_no_balance',
      details: { balance },
    };
  }

  // Split signature into v, r, s per EIP-3009.
  const { authorization, signature } = payload.payload;
  const sig = parseSignature(signature);
  // EIP-3009 expects v in {27, 28}. viem returns either {r, s, v, yParity}
  // or {r, s, yParity} (post-EIP-2098 compact form). Both shapes carry
  // `yParity` (number, 0|1); we prefer that. Defaulting to 0 when both
  // are missing would silently corrupt v for half of all signatures, so
  // we refuse to broadcast and classify as `gas_estimate_revert` (the
  // pre-broadcast bucket — see SettleReason taxonomy in tasks/7.md).
  let yParity: number;
  if (typeof sig.yParity === 'number') {
    yParity = sig.yParity;
  } else if (sig.v !== undefined) {
    yParity = Number(sig.v) - 27;
  } else {
    return {
      ok: false,
      reason: 'gas_estimate_revert',
    };
  }
  const v = 27 + yParity;

  let txHash: `0x${string}`;
  try {
    txHash = await entry.walletClient.writeContract({
      address: network.usdcAddress,
      abi: USDC_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        v,
        sig.r,
        sig.s,
      ],
      // Chain inferred from transport for the cached WalletClient — keep
      // gas estimation default; viem handles legacy/eip1559 negotiation.
      chain: null,
      account: entry.account,
    });
  } catch (err) {
    const classified = classifyWriteError(err);
    return { ok: false, ...classified };
  }

  let receipt: { status: 'success' | 'reverted' };
  try {
    receipt = await opts.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
    });
  } catch (err) {
    const classified = classifyWriteError(err);
    return { ok: false, ...classified };
  }

  if (receipt.status === 'success') {
    return { ok: true, txHash, payer: recoveredFrom };
  }
  // Receipt returned but reverted. Always classify as receipt_reverted —
  // we cannot reliably decode the revert reason post-mine, so we do not
  // guess `authorization_already_used_onchain` here.
  return { ok: false, reason: 'receipt_reverted' };
}
