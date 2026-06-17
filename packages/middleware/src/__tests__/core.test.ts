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
  it('malformed base64 X-PAYMENT returns 400 malformed_payment_header + emits malformed_header phase:base64 or json', async () => {
    const logger = makeLogger();
    // Buffer.from is permissive with malformed base64, so we feed something
    // that decodes to invalid UTF-8 / non-JSON. The classifier treats this
    // as either 'base64' or 'json' phase — both are accepted here.
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
    expect(logger.securityEvent).toHaveBeenCalledWith(
      'malformed_header',
      expect.objectContaining({ phase: expect.stringMatching(/^(base64|json|shape)$/) }),
    );
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
    expect(calls[0]![1]).toEqual({
      expected: 5042002,
      actual: 1,
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
  ] as const)('verify returns %s → core emits %s once', async (verifyReason, eventName) => {
    verifySpy.mockImplementationOnce(async () => ({ ok: false, reason: verifyReason }));
    const logger = makeLogger();
    const headerValue = encodeXPayment(makePayload());
    await paywall({ headers: { 'x-payment': headerValue } }, makeOpts({ logger }));
    const emitCalls = logger.securityEvent.mock.calls.filter((c) => c[0] === eventName);
    expect(emitCalls).toHaveLength(1);
  });

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
