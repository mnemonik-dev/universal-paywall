import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BaseError,
  ContractFunctionExecutionError,
  HttpRequestError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { InsufficientFundsError } from 'viem';
import { NETWORKS } from '../networks.js';
import { NonceStore } from '../replay-store.js';
import { OpaqueRelayerKey } from '../relayer-key.js';
import {
  MIN_RELAYER_USDC_BALANCE,
  NetworkMismatchError,
  settleOnChain,
  __resetSettleCacheForTests,
} from '../settle.js';
import type { PaymentPayload } from '../types.js';

const arcTestnet = NETWORKS['arc-testnet'];

const VAULT_ADDR: `0x${string}` = '0x2222222222222222222222222222222222222222';
const SIGNER_ADDR: `0x${string}` = '0x4444444444444444444444444444444444444444';
const NONCE: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
// A 65-byte signature with valid r,s and v=0x1c (28).
const SIG: `0x${string}` = ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1c') as `0x${string}`;
const TX_HASH: `0x${string}` = ('0x' + 'fe'.repeat(32)) as `0x${string}`;
const RELAYER_ADDR: `0x${string}` = '0x5555555555555555555555555555555555555555';

const SAMPLE_PK = ('0x' + 'aa'.repeat(31) + 'bb') as `0x${string}`;

function makePayload(): PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: arcTestnet.id,
    payload: {
      signature: SIG,
      authorization: {
        from: SIGNER_ADDR,
        to: VAULT_ADDR,
        value: '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: NONCE,
      },
    },
  };
}

function makeOpts(overrides: { publicClient?: Record<string, unknown> }) {
  return {
    network: 'arc-testnet',
    relayerKey: new OpaqueRelayerKey(SAMPLE_PK),
    publicClient: overrides.publicClient ?? {},
  } as Parameters<typeof settleOnChain>[2];
}

// ─── viem mock ────────────────────────────────────────────────────────────
// We mock createWalletClient and http so the settle module never touches
// real network / privateKeyToAccount stays real (so address derivation
// works).

const walletWriteSpy = vi.fn<(args: unknown) => Promise<`0x${string}`>>(async () => TX_HASH);

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      writeContract: walletWriteSpy,
    })),
    http: vi.fn(() => ({})),
  };
});

beforeEach(() => {
  __resetSettleCacheForTests();
  walletWriteSpy.mockReset();
  walletWriteSpy.mockImplementation(async () => TX_HASH);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('settleOnChain', () => {
  it('happy path writes contract and returns tx hash + payer', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toEqual({ ok: true, txHash: TX_HASH, payer: SIGNER_ADDR });
    expect(walletWriteSpy).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: TX_HASH, timeout: 30_000 }),
    );
  });

  it('chainId pin matches → no throw; second call same network skips getChainId', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    };
    const opts = makeOpts({ publicClient });
    await settleOnChain(makePayload(), SIGNER_ADDR, opts);
    expect(publicClient.getChainId).toHaveBeenCalledTimes(1);
    await settleOnChain(makePayload(), SIGNER_ADDR, opts);
    expect(publicClient.getChainId).toHaveBeenCalledTimes(1);
  });

  it('chainId pin mismatches → NetworkMismatchError with expected/observed', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId + 1),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    };
    await expect(
      settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient })),
    ).rejects.toMatchObject({
      name: 'NetworkMismatchError',
      expectedChainId: arcTestnet.chainId,
      observedChainId: arcTestnet.chainId + 1,
    });
  });

  it('relayer balance 0 returns relayer_no_balance proactively (writeContract NOT called)', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 0n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toEqual({
      ok: false,
      reason: 'relayer_no_balance',
      details: { balance: 0n },
    });
    expect(walletWriteSpy).not.toHaveBeenCalled();
  });

  it('relayer balance just below MIN_RELAYER_USDC_BALANCE returns relayer_no_balance', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => MIN_RELAYER_USDC_BALANCE - 1n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toEqual({
      ok: false,
      reason: 'relayer_no_balance',
      details: { balance: MIN_RELAYER_USDC_BALANCE - 1n },
    });
    expect(walletWriteSpy).not.toHaveBeenCalled();
  });

  it('relayer balance equal to MIN_RELAYER_USDC_BALANCE passes proactive check (strict <)', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => MIN_RELAYER_USDC_BALANCE),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result.ok).toBe(true);
  });

  it('readContract returns non-bigint balance → rpc_5xx (defensive guard)', async () => {
    // A misbehaving RPC / test double could return a string or number for
    // balanceOf. The guard in settle.ts must classify this as rpc_5xx
    // (the data plane is broken) rather than coerce to bigint and crash
    // or silently leak the wrong type into details.balance downstream.
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => '10000000'),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toEqual({ ok: false, reason: 'rpc_5xx' });
    expect(walletWriteSpy).not.toHaveBeenCalled();
  });

  it('rpc TimeoutError → rpc_timeout', async () => {
    walletWriteSpy.mockImplementation(async () => {
      throw new TimeoutError({ body: {}, url: 'https://rpc.local' });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'rpc_timeout' });
  });

  it('HttpRequestError 502 → rpc_5xx', async () => {
    walletWriteSpy.mockImplementation(async () => {
      throw new HttpRequestError({
        url: 'https://rpc.local',
        status: 502,
      });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'rpc_5xx' });
  });

  it('HttpRequestError 429 (rate-limit) → rpc_5xx (any HTTP error bucket)', async () => {
    // The classifier treats any HttpRequestError as rpc_5xx — including
    // 4xx rate-limit / auth failures — because the 7-reason taxonomy
    // has no separate 4xx slot and conflating them with rpc_timeout
    // would mislead operators.
    walletWriteSpy.mockImplementation(async () => {
      throw new HttpRequestError({
        url: 'https://rpc.local',
        status: 429,
      });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'rpc_5xx' });
  });

  it('ContractFunctionExecutionError during writeContract → gas_estimate_revert', async () => {
    walletWriteSpy.mockImplementation(async () => {
      const cause = new BaseError('gas estimate revert');
      throw new ContractFunctionExecutionError(cause, {
        abi: [],
        functionName: 'transferWithAuthorization',
      });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'gas_estimate_revert' });
  });

  it('WaitForTransactionReceiptTimeoutError → mine_timeout (distinct from rpc_timeout)', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => {
        throw new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH });
      }),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'mine_timeout' });
  });

  it("receipt status 'reverted' → receipt_reverted", async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'receipt_reverted' });
  });

  it('reactive InsufficientFundsError during writeContract → relayer_no_balance', async () => {
    walletWriteSpy.mockImplementation(async () => {
      throw new InsufficientFundsError({});
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'relayer_no_balance' });
  });

  it('authorization-already-used detected via case-insensitive substring match', async () => {
    walletWriteSpy.mockImplementation(async () => {
      const cause = new BaseError(
        'execution reverted: FiatTokenV2: authorization is used or canceled',
      );
      throw new ContractFunctionExecutionError(cause, {
        abi: [],
        functionName: 'transferWithAuthorization',
      });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'authorization_already_used_onchain',
    });
  });

  it('authorization-already-used: case variant uppercase still matched', async () => {
    walletWriteSpy.mockImplementation(async () => {
      const cause = new BaseError('REVERT: AUTHORIZATION IS USED OR CANCELED');
      throw new ContractFunctionExecutionError(cause, {
        abi: [],
        functionName: 'transferWithAuthorization',
      });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'authorization_already_used_onchain',
    });
  });

  it('writeContract throws ContractFunctionExecutionError with revert reason that cannot be matched → gas_estimate_revert (no auth_already_used guess)', async () => {
    // The classifier must NOT promote a generic ContractFunctionExecutionError
    // to authorization_already_used_onchain unless the literal substring
    // "authorization is used" appears. Generic revert reasons get classified
    // as gas_estimate_revert (the documented pre-broadcast bucket).
    walletWriteSpy.mockImplementation(async () => {
      const cause = new BaseError('execution reverted: some unrelated revert');
      throw new ContractFunctionExecutionError(cause, {
        abi: [],
        functionName: 'transferWithAuthorization',
      });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'gas_estimate_revert' });
  });

  it('no SecurityLogger import or call (static + runtime)', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '..', 'settle.ts'), 'utf8');
    // Strip block + line comments before grepping — comments may legitimately
    // document the constraint (e.g. "No SecurityLogger import"). What we
    // forbid is an actual import statement or method invocation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/from\s+['"][^'"]*SecurityLogger[^'"]*['"]/);
    expect(code).not.toMatch(/\.securityEvent\s*\(/);
    expect(code).not.toMatch(/SecurityLogger/);
    // Runtime: opts shape does not require a logger field.
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result.ok).toBe(true);
  });

  it('WalletClient built from OpaqueRelayerKey — raw key not enumerable in errors or opts', async () => {
    // Force an error path and confirm the raw key never appears in any
    // serialized form — neither in the returned SettleResult nor in
    // anything reachable through opts (which holds the OpaqueRelayerKey
    // wrapper).
    walletWriteSpy.mockImplementation(async () => {
      throw new BaseError('some error');
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const opts = makeOpts({ publicClient });
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, opts);
    const rawKeyStripped = SAMPLE_PK.slice(2).toLowerCase();
    const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    const serializedResult = JSON.stringify(result, replacer);
    const serializedOpts = JSON.stringify(opts, replacer);
    expect(serializedResult.toLowerCase()).not.toContain(rawKeyStripped);
    expect(serializedOpts.toLowerCase()).not.toContain(rawKeyStripped);
  });

  it('settle failure leaves the replay-store entry inserted by verify untouched', async () => {
    // settle.ts has no NonceStore parameter — the structural enforcement
    // says it cannot import the module at all. To actually exercise the
    // contract, simulate the production flow: verify inserts into a store,
    // settle then runs and fails; we assert the store's mutation methods
    // accumulated no calls beyond what verify already made.
    walletWriteSpy.mockImplementation(async () => {
      throw new TimeoutError({ body: {}, url: 'https://rpc.local' });
    });
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const store = new NonceStore();
    const insertSpy = vi.spyOn(store, 'insert');
    const checkSpy = vi.spyOn(store, 'checkAndInsert');
    // Plant an entry via the same path verify uses in production.
    store.checkAndInsert({
      from: SIGNER_ADDR,
      nonce: NONCE,
      validBefore: 9_999_999_999_000,
      now: 1_700_000_000_000,
    });
    expect(store.size()).toBe(1);
    const insertCallsAfterVerify = insertSpy.mock.calls.length;
    const checkCallsAfterVerify = checkSpy.mock.calls.length;

    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false });

    // settle.ts must never touch the store after verify. Compare counts.
    expect(insertSpy.mock.calls.length).toBe(insertCallsAfterVerify);
    expect(checkSpy.mock.calls.length).toBe(checkCallsAfterVerify);
    expect(store.size()).toBe(1);

    // Static check: settle.ts must not import the replay-store module.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '..', 'settle.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/from\s+['"][^'"]*replay-store[^'"]*['"]/);
    expect(code).not.toMatch(/NonceStore/);
  });

  it('NetworkMismatchError class is exported with chainId fields', () => {
    const err = new NetworkMismatchError(1, 2);
    expect(err.name).toBe('NetworkMismatchError');
    expect(err.expectedChainId).toBe(1);
    expect(err.observedChainId).toBe(2);
  });

  it('balanceOf RPC throws viem TimeoutError → reason rpc_timeout (classifier on balance read)', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => {
        throw new TimeoutError({ body: {}, url: 'https://rpc.local' });
      }),
      waitForTransactionReceipt: vi.fn(),
    };
    const result = await settleOnChain(makePayload(), SIGNER_ADDR, makeOpts({ publicClient }));
    expect(result).toMatchObject({ ok: false, reason: 'rpc_timeout' });
    expect(walletWriteSpy).not.toHaveBeenCalled();
  });

  it('unknown network throws plain Error referencing the network key', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(),
    };
    const badOpts = {
      ...makeOpts({ publicClient }),
      network: 'definitely-not-a-network',
    };
    await expect(settleOnChain(makePayload(), SIGNER_ADDR, badOpts)).rejects.toThrow(
      /definitely-not-a-network/,
    );
  });
});
