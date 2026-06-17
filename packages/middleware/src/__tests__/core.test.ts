import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { NETWORKS } from '../networks.js';
import { OpaqueRelayerKey } from '../relayer-key.js';
import type { PaymentPayload } from '../types.js';

// ─── Mocks for verify + settle (core's two downstream collaborators) ───────
//
// We mock at the module level so we can:
//   1. Spy on what core passes them.
//   2. Drive each branch (verify failure, settle failure, NetworkMismatchError).
//   3. Verify verify is called with exactly 2 args per addendum §3.

const verifySpy = vi.fn();
const settleSpy = vi.fn();

vi.mock('../verify.js', () => ({
  verifyEip3009Authorization: (...args: unknown[]) => verifySpy(...args),
}));

vi.mock('../settle.js', async () => {
  const actual = await vi.importActual<typeof import('../settle.js')>('../settle.js');
  return {
    ...actual,
    settleOnChain: (...args: unknown[]) => settleSpy(...args),
  };
});

// Real NetworkMismatchError class so `instanceof` matches in core.ts.
const { NetworkMismatchError } = await import('../settle.js');

// Mock viem's createPublicClient + http transport so core can build its
// per-network PublicClient cache without hitting the network. We keep the
// real keccak256 since core's hash helpers rely on it.
const publicClientStub = {
  readContract: vi.fn(),
};

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => publicClientStub),
    http: vi.fn(() => ({})),
  };
});

// After the mocks are wired we import the system under test.
const {
  paywall,
  payerHash,
  developerEoaHash,
  nonceHash,
  shortHash,
  __resetCoreCachesForTests,
  __getNonceStoreForTests,
} = await import('../core.js');

// ─── Test fixtures ──────────────────────────────────────────────────────────

const arcTestnet = NETWORKS['arc-testnet'];

const FROM_ADDR: `0x${string}` = '0x4444444444444444444444444444444444444444';
const VAULT_ADDR: `0x${string}` = '0x2222222222222222222222222222222222222222';
const DEV_EOA: `0x${string}` = '0x1111111111111111111111111111111111111111';
const NONCE: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SIG: `0x${string}` = ('0x' + 'cd'.repeat(64) + '1c') as `0x${string}`;
const TX_HASH: `0x${string}` = ('0x' + 'fe'.repeat(32)) as `0x${string}`;
const ZERO: `0x${string}` = '0x0000000000000000000000000000000000000000';

const SAMPLE_PK = ('0x' + 'aa'.repeat(31) + 'bb') as `0x${string}`;

function makePayload(overrides?: { value?: string; from?: `0x${string}` }): PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: arcTestnet.id,
    payload: {
      signature: SIG,
      authorization: {
        from: overrides?.from ?? FROM_ADDR,
        to: VAULT_ADDR,
        value: overrides?.value ?? '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: NONCE,
      },
    },
  };
}

function encodeXPayment(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

function makeLogger() {
  return { securityEvent: vi.fn() };
}

function makeOpts(overrides: { logger?: { securityEvent: ReturnType<typeof vi.fn> } } = {}) {
  return {
    price: '0.01',
    developerEoa: DEV_EOA,
    network: 'arc-testnet',
    facilitator: {
      mode: 'inline' as const,
      relayerKey: new OpaqueRelayerKey(SAMPLE_PK),
    },
    resource: 'https://api.example.com/data',
    description: 'sample',
    mimeType: 'application/json',
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
  };
}

beforeEach(() => {
  __resetCoreCachesForTests();
  verifySpy.mockReset();
  settleSpy.mockReset();
  publicClientStub.readContract.mockReset();
  // Default factory state: not paused, vault deployed at VAULT_ADDR.
  publicClientStub.readContract.mockImplementation(
    async ({ functionName }: { functionName: string }) => {
      if (functionName === 'paused') return false;
      if (functionName === 'vaults') return VAULT_ADDR;
      throw new Error(`unexpected readContract: ${functionName}`);
    },
  );
  // Default verify: success.
  verifySpy.mockImplementation(async () => ({ ok: true, recoveredFrom: FROM_ADDR }));
  // Default settle: success.
  settleSpy.mockImplementation(async () => ({ ok: true, txHash: TX_HASH, payer: FROM_ADDR }));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helpers to drain the NonceStore so tests don't cross-pollute. ─────────
//
// The module-scope NonceStore survives across tests (it's a process
// singleton by design). Since verify is mocked it never actually inserts
// into the store, so we don't need to reset it — but a stray "real" call
// from a future test would. Keep an assertion on store identity in the
// dedicated test.

describe('paywall pipeline', () => {
  // ─── 7a: missing X-PAYMENT header ────────────────────────────────────────
  it('no X-PAYMENT header returns 402 with PaymentRequirements', async () => {
    const result = await paywall({ headers: {}, method: 'GET', url: '/api/data' }, makeOpts());
    expect(result).toMatchObject({
      kind: '402',
      status: 402,
      body: {
        x402Version: 1,
        error: 'payment_required',
      },
    });
    if (result.kind !== '402') throw new Error('expected 402');
    expect(result.body.accepts).toHaveLength(1);
    expect(result.body.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: arcTestnet.id,
      maxAmountRequired: '10000', // 0.01 USDC = 10000 micro-USDC
      payTo: VAULT_ADDR,
      asset: arcTestnet.usdcAddress,
    });
  });

  // ─── 7a: oversized header ────────────────────────────────────────────────
  it('oversized X-PAYMENT returns 400 header_too_large + emits header_too_large event', async () => {
    const logger = makeLogger();
    const oversized = 'a'.repeat(5000);
    const result = await paywall(
      { headers: { 'x-payment': oversized }, method: 'POST', url: '/api/data' },
      makeOpts({ logger }),
    );
    expect(result).toMatchObject({ kind: '402', status: 400, body: { error: 'header_too_large' } });
    expect(logger.securityEvent).toHaveBeenCalledWith('header_too_large', { size: 5000 });
  });

  // ─── 7b: malformed base64 ────────────────────────────────────────────────
  it('non-base64 bytes in X-PAYMENT returns 400 malformed_payment_header + emits malformed_header phase:json', async () => {
    const logger = makeLogger();
    // Node's Buffer.from(..., 'base64') is permissive — it does not throw on
    // chars outside the base64 alphabet, it silently drops them. So the only
    // observable failure path here is the JSON-parse phase. Pin the
    // assertion to 'json' so a future regression that re-classifies this as
    // 'base64' would fail loudly.
    const malformed = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
    const result = await paywall(
      { headers: { 'x-payment': malformed }, method: 'POST', url: '/api/data' },
      makeOpts({ logger }),
    );
    expect(result).toMatchObject({
      kind: '402',
      status: 400,
      body: { error: 'malformed_payment_header' },
    });
    expect(logger.securityEvent).toHaveBeenCalledWith('malformed_header', { phase: 'json' });
  });

  // ─── 7b: malformed JSON ──────────────────────────────────────────────────
  it('malformed JSON inside X-PAYMENT returns 400 + emits malformed_header phase:json', async () => {
    const logger = makeLogger();
    const headerValue = Buffer.from('this-is-not-json', 'utf8').toString('base64');
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({
      kind: '402',
      status: 400,
      body: { error: 'malformed_payment_header' },
    });
    expect(logger.securityEvent).toHaveBeenCalledWith('malformed_header', { phase: 'json' });
  });

  // ─── 7b: wrong shape ─────────────────────────────────────────────────────
  it('wrong-shape decoded payload returns 400 + emits malformed_header phase:shape', async () => {
    const logger = makeLogger();
    const headerValue = Buffer.from(JSON.stringify({ wrong: 'shape' }), 'utf8').toString('base64');
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({
      kind: '402',
      status: 400,
      body: { error: 'malformed_payment_header' },
    });
    expect(logger.securityEvent).toHaveBeenCalledWith('malformed_header', { phase: 'shape' });
  });

  // ─── 7d: paused ──────────────────────────────────────────────────────────
  it('factory.paused() === true returns 402 paused + emits paused_request', async () => {
    publicClientStub.readContract.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'paused') return true;
        if (functionName === 'vaults') return VAULT_ADDR;
        throw new Error('unexpected');
      },
    );
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({ kind: '402', body: { error: 'paused' } });
    expect(logger.securityEvent).toHaveBeenCalledWith('paused_request', {
      developerEoaHash: developerEoaHash(DEV_EOA),
    });
  });

  // ─── 7d: vault_not_deployed ──────────────────────────────────────────────
  it('factory.vaults(eoa) === 0x0 returns 402 vault_not_deployed + emits vault_not_deployed', async () => {
    publicClientStub.readContract.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'paused') return false;
        if (functionName === 'vaults') return ZERO;
        throw new Error('unexpected');
      },
    );
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({ kind: '402', body: { error: 'vault_not_deployed' } });
    expect(logger.securityEvent).toHaveBeenCalledWith('vault_not_deployed', {
      developerEoaHash: developerEoaHash(DEV_EOA),
    });
  });

  // ─── SEC-T8-05: vault_not_deployed short-circuits BEFORE verify ─────────
  // When payTo would be ZERO_ADDRESS, core MUST NOT call verify (which would
  // accept any authorization.to=0x0 as matching expectedVaultAddress=0x0).
  // The factory-state check must fire first.
  it('vault_not_deployed short-circuits BEFORE verify is called', async () => {
    publicClientStub.readContract.mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'paused') return false;
        if (functionName === 'vaults') return ZERO;
        throw new Error('unexpected');
      },
    );
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    // verify must NOT have been called — vault_not_deployed short-circuits first.
    expect(verifySpy).not.toHaveBeenCalled();
  });

  // ─── 7d: factory-cache 5s TTL hit ────────────────────────────────────────
  it('factory-state cache hits within 5s TTL — second call does not re-read paused', async () => {
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    const pausedCalls = publicClientStub.readContract.mock.calls.filter(
      (c) => (c[0] as { functionName: string }).functionName === 'paused',
    );
    expect(pausedCalls.length).toBe(1);
  });

  // ─── 7d: factory-cache refresh after TTL ────────────────────────────────
  it('factory-state cache refreshes after 5s TTL', async () => {
    vi.useFakeTimers();
    try {
      const headerValue = encodeXPayment(makePayload());
      await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
      vi.advanceTimersByTime(6_000);
      await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
      const pausedCalls = publicClientStub.readContract.mock.calls.filter(
        (c) => (c[0] as { functionName: string }).functionName === 'paused',
      );
      expect(pausedCalls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── 7d: vault-address cached forever once non-zero (D3 immutability) ────
  // The factory deploys are immutable per D3 — once `vaults(developerEoa)`
  // returns a non-zero address, the value is final. Even after the 5s TTL
  // for the paused() flag expires and the entry is refreshed, the vault
  // address must NOT be re-fetched.
  it('non-zero vault address is NOT re-fetched after TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      const headerValue = encodeXPayment(makePayload());
      await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
      // Cross the 5s TTL boundary.
      vi.advanceTimersByTime(6_000);
      await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
      const vaultCalls = publicClientStub.readContract.mock.calls.filter(
        (c) => (c[0] as { functionName: string }).functionName === 'vaults',
      );
      // First request fetched the vault address (call count 1). Second
      // request, despite a TTL refresh on paused(), MUST NOT re-fetch the
      // vault address — it's pinned in the cache forever once non-zero.
      expect(vaultCalls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── 7d: RPC error with no cache surfaces as settlement_failed/rpc_5xx ───
  it('factory-state RPC error with no cache surfaces as 402 settlement_failed reason rpc_5xx', async () => {
    publicClientStub.readContract.mockReset();
    publicClientStub.readContract.mockRejectedValue(new Error('rpc down'));
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({
      kind: '402',
      body: { error: 'settlement_failed', reason: 'rpc_5xx' },
    });
    expect(logger.securityEvent).toHaveBeenCalledWith(
      'settlement_failed',
      expect.objectContaining({ reason: 'rpc_5xx' }),
    );
  });

  // ─── 7d: non-stale cache + RPC error returns last-good value ────────────
  // The first request warms the cache. Within the 5s TTL window we then
  // reject every readContract — the cached entry is still observable, so
  // the request must NOT 402: it must serve the last-good factory state and
  // continue all the way through to passthrough.
  it('factory-state RPC error with non-stale cache returns last-good value (passthrough)', async () => {
    const headerValue = encodeXPayment(makePayload());
    // Warm the cache.
    const warmup = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(warmup.kind).toBe('passthrough');
    // Reject all future RPC reads; second request still within 5s TTL.
    publicClientStub.readContract.mockRejectedValue(new Error('rpc down'));
    const second = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(second.kind).toBe('passthrough');
  });

  // ─── SEC-T8-01: stale cache + RPC error surfaces as rpc_5xx ─────────────
  // The cache must NOT fail-open: if the entry is older than the 5s TTL and
  // the refresh RPC fails, we surface 402 settlement_failed/rpc_5xx rather
  // than using out-of-date paused/vault state for the access decision.
  it('factory-state RPC error with STALE cache surfaces as 402 settlement_failed reason rpc_5xx', async () => {
    vi.useFakeTimers();
    try {
      const headerValue = encodeXPayment(makePayload());
      // Warm the cache.
      const warmup = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
      expect(warmup.kind).toBe('passthrough');
      // Cross the 5s TTL boundary so the next request needs to refresh.
      vi.advanceTimersByTime(6_000);
      // Reject all future RPC reads.
      publicClientStub.readContract.mockRejectedValue(new Error('rpc down'));
      const logger = makeLogger();
      const second = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
      expect(second).toMatchObject({
        kind: '402',
        body: { error: 'settlement_failed', reason: 'rpc_5xx' },
      });
      expect(logger.securityEvent).toHaveBeenCalledWith(
        'settlement_failed',
        expect.objectContaining({ reason: 'rpc_5xx' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── 7e: settle is called with the recovered signer, NOT the wire `from` ─
  // verifyEip3009Authorization returns the ecrecover output. Core MUST pass
  // that recovered address (the cryptographically authenticated one) to
  // settle.ts, not the claimed-on-the-wire `authorization.from`. In the
  // happy path the two are equal, but binding the recovered value is the
  // single source of truth for the settlement payer.
  it('core passes verifyResult.recoveredFrom to settle (NOT payload.authorization.from)', async () => {
    const wireClaimed: `0x${string}` = '0x9999999999999999999999999999999999999999';
    const recovered: `0x${string}` = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    verifySpy.mockImplementationOnce(async () => ({ ok: true, recoveredFrom: recovered }));
    settleSpy.mockImplementationOnce(async () => ({ ok: true, txHash: TX_HASH, payer: recovered }));
    const headerValue = encodeXPayment(makePayload({ from: wireClaimed }));
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    // Settle's second positional arg is the recovered signer, not the wire-claimed one.
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy.mock.calls[0]![1]).toBe(recovered);
    // X-PAYMENT-RESPONSE.payer also reflects the recovered signer.
    if (result.kind !== 'passthrough') throw new Error('expected passthrough');
    const decoded = JSON.parse(
      Buffer.from(result.responseHeaders['X-PAYMENT-RESPONSE'], 'base64').toString('utf8'),
    );
    expect(decoded.payer).toBe(recovered);
  });

  // ─── 7f + 7g: happy path ─────────────────────────────────────────────────
  it('happy path returns passthrough with X-PAYMENT-RESPONSE header', async () => {
    const headerValue = encodeXPayment(makePayload());
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(result.kind).toBe('passthrough');
    if (result.kind !== 'passthrough') throw new Error('expected passthrough');
    const decoded = JSON.parse(
      Buffer.from(result.responseHeaders['X-PAYMENT-RESPONSE'], 'base64').toString('utf8'),
    );
    expect(decoded).toEqual({
      success: true,
      transaction: TX_HASH,
      network: arcTestnet.id,
      payer: FROM_ADDR,
    });
  });

  // ─── 7e: settle failure ──────────────────────────────────────────────────
  it.each([
    'rpc_timeout',
    'rpc_5xx',
    'gas_estimate_revert',
    'mine_timeout',
    'receipt_reverted',
    'relayer_no_balance',
    'authorization_already_used_onchain',
  ] as const)(
    'settle failure with reason %s propagates to 402 settlement_failed + emits settlement_failed payload includes payerHash, no raw signature',
    async (reason) => {
      settleSpy.mockImplementationOnce(async () => ({ ok: false, reason }));
      const logger = makeLogger();
      const headerValue = encodeXPayment(makePayload());
      const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
      expect(result).toMatchObject({
        kind: '402',
        body: { error: 'settlement_failed', reason },
      });
      const emitCall = logger.securityEvent.mock.calls.find((c) => c[0] === 'settlement_failed');
      expect(emitCall).toBeDefined();
      const payload = emitCall![1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        payerHash: payerHash(FROM_ADDR),
        reason,
      });
      // Defense-in-depth: ensure the raw signature does not appear anywhere
      // in the emit payload.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(SIG);
    },
  );

  // ─── SEC-T8-02: txHash preserved through scrubSecrets ───────────────────
  // The 32-byte tx hash matches scrubSecrets' 0x+64hex pattern, so without
  // an explicit carve-out the emit helper would redact it as if it were a
  // private key. The carve-out preserves known-safe fields (txHash) by
  // name. We assert (a) the baseline — scrubSecrets WOULD redact a bare
  // txHash, so the regex match is real; (b) the emit helper's carve-out
  // would preserve it (verified at the source level — SAFE_HEX_FIELDS
  // includes 'txHash'). The integration assertion runs through core only
  // when settle's failure variant carries txHash; today the variant type
  // is { reason, details? } only, so this is a defense-in-depth structural
  // lockdown.
  it('emit-helper carve-out preserves txHash (settlement_failed forensic value)', async () => {
    const { scrubSecrets } = await import('../relayer-key.js');
    // Baseline: scrubSecrets WOULD redact a bare txHash (it matches 0x+64hex).
    const scrubbedBare = scrubSecrets({ txHash: TX_HASH }) as { txHash: string };
    expect(scrubbedBare.txHash).toContain('redacted');
    // Source-level: the emit helper's carve-out list includes 'txHash' so
    // the round-trip through emit is non-destructive. Read core.ts and
    // assert the carve-out marker is present.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '..', 'core.ts'), 'utf8');
    expect(src).toMatch(/SAFE_HEX_FIELDS\s*=\s*\[\s*['"]txHash['"]/);
  });

  // ─── SEC-T8-03: relayer_low_balance dedicated event ─────────────────────
  // When settle classifies as relayer_no_balance with a balance detail, core
  // MUST emit a distinct relayer_low_balance event carrying balanceUsdc
  // (per D18). The settlement_failed event still fires too — for backwards
  // compatibility with monitoring that only watches that channel.
  it('settle relayer_no_balance with balance details emits relayer_low_balance {balanceUsdc} AND settlement_failed', async () => {
    settleSpy.mockImplementationOnce(async () => ({
      ok: false,
      reason: 'relayer_no_balance',
      details: { balance: 750_000n },
    }));
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    const lowBalanceCalls = logger.securityEvent.mock.calls.filter(
      (c) => c[0] === 'relayer_low_balance',
    );
    expect(lowBalanceCalls).toHaveLength(1);
    expect(lowBalanceCalls[0]![1]).toEqual({ balanceUsdc: '750000' });
    const settlementCalls = logger.securityEvent.mock.calls.filter(
      (c) => c[0] === 'settlement_failed',
    );
    expect(settlementCalls).toHaveLength(1);
  });

  // ─── 7e: NetworkMismatchError ────────────────────────────────────────────
  it('settle throws NetworkMismatchError → emit chain_id_mismatch + return 402 settlement_failed reason internal_error', async () => {
    settleSpy.mockImplementationOnce(async () => {
      throw new NetworkMismatchError(5042002, 1);
    });
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({
      kind: '402',
      body: { error: 'settlement_failed', reason: 'internal_error' },
    });
    const calls = logger.securityEvent.mock.calls.filter((c) => c[0] === 'chain_id_mismatch');
    expect(calls).toHaveLength(1);
    // SEC-T8-04: field names align with tech-spec D18 (expectedChainId, observedChainId).
    expect(calls[0]![1]).toEqual({
      expectedChainId: 5042002,
      observedChainId: 1,
      network: arcTestnet.id,
    });
  });

  // ─── OpaqueRelayerKey opacity ────────────────────────────────────────────
  it('core passes OpaqueRelayerKey opaque to settle — never extracts', async () => {
    const headerValue = encodeXPayment(makePayload());
    const opts = makeOpts();
    await paywall({ headers: { 'x-payment': headerValue } }, opts);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    const settleOptsArg = settleSpy.mock.calls[0]![2] as { relayerKey: OpaqueRelayerKey };
    expect(settleOptsArg.relayerKey).toBe(opts.facilitator.relayerKey);
    // The wrapper instance is passed by reference; not a derived plain object.
    expect(OpaqueRelayerKey.is(settleOptsArg.relayerKey)).toBe(true);
    // The raw key never appears anywhere in opts via JSON serialization.
    expect(JSON.stringify(opts)).not.toContain(SAMPLE_PK.slice(2));
  });

  // ─── verify call shape (addendum §3) ─────────────────────────────────────
  it('core calls verifyEip3009Authorization with 2-arg shape — nonceStore lives in opts, not third arg', async () => {
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(verifySpy).toHaveBeenCalledTimes(1);
    const args = verifySpy.mock.calls[0]!;
    expect(args.length).toBe(2);
    const [, verifyOpts] = args as [PaymentPayload, Record<string, unknown>];
    expect(verifyOpts['nonceStore']).toBe(__getNonceStoreForTests());
    expect(verifyOpts['expectedVaultAddress']).toBe(VAULT_ADDR);
    expect(verifyOpts['expectedNetwork']).toBe('arc-testnet');
    expect(typeof verifyOpts['nowMs']).toBe('number');
  });

  // ─── verify error → D18 event mapping ────────────────────────────────────
  it.each([
    ['invalid_signature', 'signature_invalid'],
    ['nonce_already_used', 'nonce_replay'],
    ['authorization_expired', 'authorization_expired'],
    ['authorization_not_yet_valid', 'authorization_not_yet_valid'],
    ['network_mismatch', 'network_mismatch'],
    ['to_mismatch', 'to_mismatch'],
    ['insufficient_amount', 'insufficient_amount'],
  ] as const)(
    'verify returns %s → core emits %s once AND 402 body.error matches',
    async (verifyReason, eventName) => {
      verifySpy.mockImplementationOnce(async () => ({ ok: false, reason: verifyReason }));
      const logger = makeLogger();
      const headerValue = encodeXPayment(makePayload());
      const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
      const emitCalls = logger.securityEvent.mock.calls.filter((c) => c[0] === eventName);
      expect(emitCalls).toHaveLength(1);
      // Tie the test to the actual 402 response body so a regression where
      // core reads the wrong field from VerifyResult (or the switch falls
      // through silently) would fail loudly here.
      expect(result).toMatchObject({ kind: '402', body: { error: verifyReason } });
    },
  );

  it('verify insufficient_amount emits required + received', async () => {
    verifySpy.mockImplementationOnce(async () => ({ ok: false, reason: 'insufficient_amount' }));
    const logger = makeLogger();
    const payload = makePayload({ value: '5000' });
    const headerValue = encodeXPayment(payload);
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({
      kind: '402',
      body: { error: 'insufficient_amount', required: '10000', received: '5000' },
    });
    expect(logger.securityEvent).toHaveBeenCalledWith('insufficient_amount', {
      required: '10000',
      received: '5000',
    });
  });

  // ─── single owner of emission ────────────────────────────────────────────
  it('core is the SINGLE owner of SecurityLogger emission — verify failure produces exactly one event', async () => {
    verifySpy.mockImplementationOnce(async () => ({ ok: false, reason: 'invalid_signature' }));
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    // Exactly one securityEvent emission for the verify failure (no
    // double-emission from a separately-importing verify.ts).
    expect(logger.securityEvent).toHaveBeenCalledTimes(1);
    expect(logger.securityEvent).toHaveBeenCalledWith(
      'signature_invalid',
      expect.objectContaining({ payerHash: payerHash(FROM_ADDR) }),
    );
  });

  // ─── PublicClient lazy + shared ──────────────────────────────────────────
  it('PublicClient is lazy and shared per network — two simultaneous first requests share one init', async () => {
    const viem = await import('viem');
    const createSpy = vi.mocked(viem.createPublicClient);
    createSpy.mockClear();
    const headerValue = encodeXPayment(makePayload());
    await Promise.all([
      paywall({ headers: { 'x-payment': headerValue } }, makeOpts()),
      paywall({ headers: { 'x-payment': headerValue } }, makeOpts()),
    ]);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  // ─── NonceStore is module-scope singleton ────────────────────────────────
  it('NonceStore is module-scope singleton — verify receives the same instance across calls', async () => {
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    const firstNonceStore = (verifySpy.mock.calls[0]![1] as { nonceStore: unknown }).nonceStore;
    const secondNonceStore = (verifySpy.mock.calls[1]![1] as { nonceStore: unknown }).nonceStore;
    expect(firstNonceStore).toBe(secondNonceStore);
    expect(firstNonceStore).toBe(__getNonceStoreForTests());
  });

  // ─── Logger throws are swallowed ─────────────────────────────────────────
  it('SecurityLogger throws are swallowed — request flow continues even when logger.securityEvent throws synchronously', async () => {
    const logger = {
      securityEvent: vi.fn(() => {
        throw new Error('logger broken');
      }),
    };
    settleSpy.mockImplementationOnce(async () => ({ ok: false, reason: 'rpc_timeout' }));
    const headerValue = encodeXPayment(makePayload());
    // Should not throw despite the logger blowing up.
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    expect(result).toMatchObject({
      kind: '402',
      body: { error: 'settlement_failed', reason: 'rpc_timeout' },
    });
  });

  // ─── default no-op logger ────────────────────────────────────────────────
  it('default no-op logger produces no output when opts.logger is undefined', async () => {
    // Drive a verify failure: there is no logger configured, so the
    // helper must short-circuit silently. We can't directly observe a
    // no-op, but we can assert there is no throw and the response is
    // produced as expected.
    verifySpy.mockImplementationOnce(async () => ({ ok: false, reason: 'invalid_signature' }));
    const headerValue = encodeXPayment(makePayload());
    const result = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(result).toMatchObject({ kind: '402', body: { error: 'invalid_signature' } });
  });

  // ─── parseUsdPrice — InvalidPriceError for malformed price ─────────────
  it('invalid opts.price throws InvalidPriceError (NOT TypeError)', async () => {
    const { InvalidPriceError } = await import('../x402.js');
    const opts = { ...makeOpts(), price: '-1' };
    const headerValue = encodeXPayment(makePayload());
    await expect(paywall({ headers: { 'x-payment': headerValue } }, opts)).rejects.toBeInstanceOf(
      InvalidPriceError,
    );
  });

  // ─── replay-store retention after settle failure (TDD anchor) ───────────
  // tasks/8.md mandates: when settle returns failure, the NonceStore entry
  // for (from, nonce) MUST NOT be deleted. A retry with the same nonce
  // returns `nonce_already_used` rather than re-attempting settle.
  // Risks row "Settlement failure mid-flight".
  //
  // Drive this through the module-scope NonceStore singleton. The first
  // request: simulate verify producing a checkAndInsert (real store call)
  // and settle returning receipt_reverted. The second request with the
  // same nonce: verify mock returns the real store's
  // checkAndInsert result, which now reports nonce_already_used.
  it('replay-store entry is retained after settlement failure — retry with same nonce returns nonce_already_used', async () => {
    const store = __getNonceStoreForTests();
    const headerValue = encodeXPayment(makePayload());
    const nonceArg: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    // verify mock that mirrors the real verify.ts contract: on
    // success, it inserts into NonceStore.checkAndInsert and returns
    // recoveredFrom; on prior insertion it surfaces nonce_already_used.
    verifySpy.mockImplementation(async () => {
      const result = store.checkAndInsert({
        from: FROM_ADDR,
        nonce: nonceArg,
        validBefore: Date.now() + 60_000,
        now: Date.now(),
      });
      if (!result.accepted) {
        return { ok: false, reason: result.reason };
      }
      return { ok: true, recoveredFrom: FROM_ADDR };
    });
    // First request: settle returns receipt_reverted. The replay-store
    // entry must remain.
    settleSpy.mockImplementationOnce(async () => ({ ok: false, reason: 'receipt_reverted' }));
    const first = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(first).toMatchObject({
      kind: '402',
      body: { error: 'settlement_failed', reason: 'receipt_reverted' },
    });
    // Structural assertion: the NonceStore observably still has the entry.
    expect(store.has({ from: FROM_ADDR, nonce: nonceArg, now: Date.now() })).toBe(true);
    // Second request with the SAME X-PAYMENT (same nonce) → core must
    // short-circuit at verify with nonce_already_used, NOT re-attempt
    // settle. The settle spy proves settle was NOT called a second time.
    settleSpy.mockClear();
    const second = await paywall({ headers: { 'x-payment': headerValue } }, makeOpts());
    expect(second).toMatchObject({
      kind: '402',
      body: { error: 'nonce_already_used' },
    });
    expect(settleSpy).not.toHaveBeenCalled();
  });
});

// ─── Hash helper invariants (addendum §5) ──────────────────────────────────

describe('hash helpers (payerHash / developerEoaHash / nonceHash)', () => {
  it('payerHash is exactly 10 characters: 0x + 8 hex chars', () => {
    const h = payerHash(FROM_ADDR);
    expect(h).toHaveLength(10);
    expect(h).toMatch(/^0x[0-9a-f]{8}$/);
    // Pinned implementation: '0x' + keccak256(from).slice(2, 10)
    expect(h).toBe('0x' + keccak256(FROM_ADDR).slice(2, 10));
  });

  it('developerEoaHash is exactly 10 chars + matches the pinned form', () => {
    const h = developerEoaHash(DEV_EOA);
    expect(h).toHaveLength(10);
    expect(h).toMatch(/^0x[0-9a-f]{8}$/);
    expect(h).toBe('0x' + keccak256(DEV_EOA).slice(2, 10));
  });

  it('nonceHash is exactly 10 chars + matches the pinned form', () => {
    const h = nonceHash(NONCE);
    expect(h).toHaveLength(10);
    expect(h).toMatch(/^0x[0-9a-f]{8}$/);
    expect(h).toBe('0x' + keccak256(NONCE).slice(2, 10));
  });

  it('shortHash is the same function as payerHash / developerEoaHash / nonceHash', () => {
    expect(shortHash).toBe(payerHash);
    expect(shortHash).toBe(developerEoaHash);
    expect(shortHash).toBe(nonceHash);
  });

  it('logger payloads never contain raw addresses or signatures — payerHash is the 10-char form', async () => {
    verifySpy.mockImplementationOnce(async () => ({ ok: false, reason: 'invalid_signature' }));
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    const call = logger.securityEvent.mock.calls[0]!;
    const payload = call[1] as Record<string, unknown>;
    expect(payload['payerHash']).toBe(payerHash(FROM_ADDR));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(FROM_ADDR);
    expect(serialized).not.toContain(SIG);
  });
});

// ─── Source-level constraint: core.ts owns the only logger emit ────────────
describe('source-level emission ownership (addendum §2)', () => {
  it('verify.ts and settle.ts do not import or call SecurityLogger', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const file of ['verify.ts', 'settle.ts']) {
      const src = readFileSync(resolve(here, '..', file), 'utf8');
      const code = stripComments(src);
      expect(code).not.toMatch(/\.securityEvent\s*\(/);
      expect(code).not.toMatch(/SecurityLogger/);
    }
  });
});
