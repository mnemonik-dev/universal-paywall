import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from '../eip3009/index.js';
import { OpaqueRelayerKey } from '../eip3009/index.js';
import { X402Facilitator } from '../x402-http.js';

const arcTestnet = NETWORKS['arc-testnet'];

const SIGNER_PK = ('0x' + '11'.repeat(31) + '12') as `0x${string}`;
const signer = privateKeyToAccount(SIGNER_PK);
const VAULT_ADDR: `0x${string}` = '0x2222222222222222222222222222222222222222';
const RELAYER_ADDR: `0x${string}` = '0x5555555555555555555555555555555555555555';
const RELAYER_PK = ('0x' + 'aa'.repeat(31) + 'bb') as `0x${string}`;
const TX_HASH = ('0x' + 'fe'.repeat(32)) as `0x${string}`;

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

let nonceCounter = 0;
function freshNonce(): `0x${string}` {
  nonceCounter += 1;
  return ('0x' + nonceCounter.toString(16).padStart(64, '0')) as `0x${string}`;
}

async function makePaymentPayload(
  overrides: { value?: string; nonce?: `0x${string}`; validBefore?: string } = {},
): Promise<Record<string, unknown>> {
  const authorization = {
    from: signer.address,
    to: VAULT_ADDR,
    value: overrides.value ?? '10000',
    validAfter: '0',
    // One hour out: within the handler's 24h validity-window cap.
    validBefore: overrides.validBefore ?? String(Math.floor(Date.now() / 1000) + 3600),
    nonce: overrides.nonce ?? freshNonce(),
  };
  const signature = await signer.signTypedData({
    domain: {
      name: arcTestnet.usdcEip712Name,
      version: arcTestnet.usdcEip712Version,
      chainId: arcTestnet.chainId,
      verifyingContract: arcTestnet.usdcAddress,
    },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return {
    x402Version: 1,
    scheme: 'exact',
    network: arcTestnet.id,
    payload: { signature, authorization },
  };
}

function makeRequirements(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: arcTestnet.id,
    maxAmountRequired: '10000',
    resource: 'https://example.test/resource',
    description: 'test resource',
    mimeType: 'application/json',
    payTo: VAULT_ADDR,
    maxTimeoutSeconds: 60,
    asset: arcTestnet.usdcAddress,
    extra: {
      assetTransferMethod: 'eip3009',
      name: arcTestnet.usdcEip712Name,
      version: arcTestnet.usdcEip712Version,
    },
    ...overrides,
  };
}

async function makeEnvelope(
  payloadOverrides: { value?: string; nonce?: `0x${string}`; validBefore?: string } = {},
  requirementsOverrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    x402Version: 1,
    paymentPayload: await makePaymentPayload(payloadOverrides),
    paymentRequirements: makeRequirements(requirementsOverrides),
  };
}

function makeFacilitator(
  opts: {
    settle?: ReturnType<typeof vi.fn>;
    verify?: ReturnType<typeof vi.fn>;
    publicClient?: Record<string, unknown>;
  } = {},
): X402Facilitator {
  const deps: Record<string, unknown> = {};
  if (opts.settle) deps['settle'] = opts.settle;
  if (opts.verify) deps['verify'] = opts.verify;
  return new X402Facilitator({
    network: arcTestnet,
    relayerKey: new OpaqueRelayerKey(RELAYER_PK),
    relayerAddress: RELAYER_ADDR,
    publicClient: opts.publicClient ?? {
      getChainId: vi.fn(async () => arcTestnet.chainId),
      readContract: vi.fn(async () => 10_000_000n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
    },
    ...(Object.keys(deps).length > 0 ? { deps } : {}),
  } as ConstructorParameters<typeof X402Facilitator>[0]);
}

function okSettle(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_payload: unknown, recoveredFrom: `0x${string}`) => ({
    ok: true,
    txHash: TX_HASH,
    payer: recoveredFrom,
  }));
}

describe('X402Facilitator — /supported', () => {
  it('advertises the configured network x exact plus the signer map', () => {
    expect(makeFacilitator().supported()).toEqual({
      kinds: [{ x402Version: 1, scheme: 'exact', network: arcTestnet.id }],
      signers: { [arcTestnet.id]: RELAYER_ADDR },
    });
  });
});

describe('X402Facilitator — /verify', () => {
  it('valid payment verifies with the recovered payer', async () => {
    const facilitator = makeFacilitator();
    const response = await facilitator.verify(await makeEnvelope());
    expect(response).toEqual({ isValid: true, payer: signer.address });
  });

  it('is read-only: the same payload verifies repeatedly', async () => {
    const facilitator = makeFacilitator();
    const envelope = await makeEnvelope();
    expect(await facilitator.verify(envelope)).toMatchObject({ isValid: true });
    expect(await facilitator.verify(envelope)).toMatchObject({ isValid: true });
  });

  it('rejects a wrong x402Version envelope', async () => {
    const envelope = { ...(await makeEnvelope()), x402Version: 2 };
    expect(await makeFacilitator().verify(envelope)).toEqual({
      isValid: false,
      invalidReason: 'invalid_x402_version',
    });
  });

  it('rejects a missing paymentRequirements', async () => {
    const envelope = { x402Version: 1, paymentPayload: await makePaymentPayload() };
    expect(await makeFacilitator().verify(envelope)).toEqual({
      isValid: false,
      invalidReason: 'invalid_payment_requirements',
    });
  });

  it('rejects a non-exact requirements scheme as unsupported_scheme', async () => {
    const envelope = await makeEnvelope({}, { scheme: 'stake' });
    expect(await makeFacilitator().verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'unsupported_scheme',
      payer: signer.address,
    });
  });

  it('rejects requirements for another network as invalid_network', async () => {
    const envelope = await makeEnvelope({}, { network: 'eip155:1' });
    expect(await makeFacilitator().verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_network',
    });
  });

  it('rejects requirements with a foreign asset', async () => {
    const envelope = await makeEnvelope(
      {},
      { asset: '0x9999999999999999999999999999999999999999' },
    );
    expect(await makeFacilitator().verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_payment_requirements',
    });
  });

  it('maps an underfunded authorization to invalid_exact_evm_payload_authorization_value', async () => {
    const envelope = await makeEnvelope({ value: '9999' });
    expect(await makeFacilitator().verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_value',
      payer: signer.address,
    });
  });

  it('carries the claimed payer on shape-level rejections', async () => {
    const payload = await makePaymentPayload();
    (payload['payload'] as Record<string, unknown>)['signature'] = '0xnothex';
    const envelope = {
      x402Version: 1,
      paymentPayload: payload,
      paymentRequirements: makeRequirements(),
    };
    expect(await makeFacilitator().verify(envelope)).toEqual({
      isValid: false,
      invalidReason: 'invalid_payload',
      payer: signer.address,
    });
  });
});

describe('X402Facilitator — /settle', () => {
  it('settles a valid payment and reports the transaction', async () => {
    const settle = okSettle();
    const facilitator = makeFacilitator({ settle });
    const response = await facilitator.settle(await makeEnvelope());
    expect(response).toEqual({
      success: true,
      payer: signer.address,
      transaction: TX_HASH,
      network: arcTestnet.id,
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a repeat of the same payload never settles twice', async () => {
    const settle = okSettle();
    const facilitator = makeFacilitator({ settle });
    const envelope = await makeEnvelope();
    const first = await facilitator.settle(envelope);
    const second = await facilitator.settle(envelope);
    expect(second).toEqual(first);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('burns the nonce: a peek verify after settle reports invalid_transaction_state', async () => {
    const facilitator = makeFacilitator({ settle: okSettle() });
    const envelope = await makeEnvelope();
    await facilitator.settle(envelope);
    expect(await facilitator.verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_transaction_state',
    });
  });

  it('maps a reverted settlement to invalid_transaction_state with empty transaction', async () => {
    const settle = vi.fn(async () => ({ ok: false, reason: 'receipt_reverted' }));
    const facilitator = makeFacilitator({ settle });
    expect(await facilitator.settle(await makeEnvelope())).toEqual({
      success: false,
      errorReason: 'invalid_transaction_state',
      transaction: '',
      network: arcTestnet.id,
      payer: signer.address,
    });
  });

  it('maps an RPC failure to unexpected_settle_error', async () => {
    const settle = vi.fn(async () => ({ ok: false, reason: 'rpc_timeout' }));
    const facilitator = makeFacilitator({ settle });
    expect(await facilitator.settle(await makeEnvelope())).toMatchObject({
      success: false,
      errorReason: 'unexpected_settle_error',
    });
  });

  it('rejects a malformed envelope without reaching the chain', async () => {
    const settle = okSettle();
    const facilitator = makeFacilitator({ settle });
    expect(
      await facilitator.settle({
        x402Version: 1,
        paymentPayload: 'garbage',
        paymentRequirements: makeRequirements(),
      }),
    ).toEqual({
      success: false,
      errorReason: 'invalid_payload',
      transaction: '',
      network: arcTestnet.id,
    });
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('X402Facilitator — review-round hardening (round 3)', () => {
  it('REGRESSION: a forged replay of a settled (from, nonce) never succeeds', async () => {
    const settle = okSettle();
    const facilitator = makeFacilitator({ settle });
    const honest = await makeEnvelope();
    const honestPayload = honest['paymentPayload'] as Record<string, unknown>;
    const honestAuth = (honestPayload['payload'] as Record<string, unknown>)[
      'authorization'
    ] as Record<string, unknown>;
    expect(await facilitator.settle(honest)).toMatchObject({ success: true });

    // Attacker knows (from, nonce) from the chain, forges the rest: garbage
    // signature, their own payTo. The recorded success must not leak.
    const forged = {
      x402Version: 1,
      paymentPayload: {
        x402Version: 1,
        scheme: 'exact',
        network: arcTestnet.id,
        payload: {
          signature: ('0x' + 'ff'.repeat(65)) as `0x${string}`,
          authorization: { ...honestAuth },
        },
      },
      paymentRequirements: makeRequirements({
        payTo: '0x9999999999999999999999999999999999999999',
      }),
    };
    const response = await facilitator.settle(forged);
    expect(response).toMatchObject({
      success: false,
      errorReason: 'invalid_exact_evm_payload_signature',
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('a duplicate arriving while the first settle is mining awaits the real outcome', async () => {
    let release: (value: { ok: true; txHash: `0x${string}`; payer: `0x${string}` }) => void;
    const mining = new Promise((resolve) => {
      release = resolve as typeof release;
    });
    const settle = vi.fn(() => mining);
    const facilitator = makeFacilitator({ settle });
    const envelope = await makeEnvelope();
    const first = facilitator.settle(envelope);
    const duplicate = facilitator.settle(envelope);
    release!({ ok: true, txHash: TX_HASH, payer: signer.address });
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a).toMatchObject({ success: true, transaction: TX_HASH });
    expect(b).toEqual(a);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('concurrent settles of the same payload reach the chain at most once', async () => {
    const settle = okSettle();
    const facilitator = makeFacilitator({ settle });
    const envelope = await makeEnvelope();
    const [a, b] = await Promise.all([facilitator.settle(envelope), facilitator.settle(envelope)]);
    expect(a).toMatchObject({ success: true });
    expect(b).toEqual(a);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('a failed chain write is recorded: the retry gets the same terminal error, one attempt total', async () => {
    const settle = vi.fn(async () => ({ ok: false, reason: 'receipt_reverted' }));
    const facilitator = makeFacilitator({ settle });
    const envelope = await makeEnvelope();
    const first = await facilitator.settle(envelope);
    const retry = await facilitator.settle(envelope);
    expect(first).toMatchObject({ success: false, errorReason: 'invalid_transaction_state' });
    expect(retry).toEqual(first);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('a verify-stage rejection does not poison the idempotency key', async () => {
    const settle = okSettle();
    const facilitator = makeFacilitator({ settle });
    const honest = await makeEnvelope();
    const honestPayload = honest['paymentPayload'] as Record<string, unknown>;
    const honestAuth = (honestPayload['payload'] as Record<string, unknown>)[
      'authorization'
    ] as Record<string, unknown>;
    // Forgery first: same (from, nonce), garbage signature — fails verify.
    const forged = {
      x402Version: 1,
      paymentPayload: {
        x402Version: 1,
        scheme: 'exact',
        network: arcTestnet.id,
        payload: {
          signature: ('0x' + 'ff'.repeat(65)) as `0x${string}`,
          authorization: { ...honestAuth },
        },
      },
      paymentRequirements: makeRequirements(),
    };
    expect(await facilitator.settle(forged)).toMatchObject({ success: false });
    // The honest envelope must still settle normally afterwards.
    expect(await facilitator.settle(honest)).toMatchObject({ success: true });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('verify surfaces unexpected_verify_error when the core verify throws', async () => {
    const verify = vi.fn(async () => {
      throw new Error('rpc exploded');
    });
    const facilitator = makeFacilitator({ verify });
    expect(await makeFacilitator({ verify }).verify(await makeEnvelope())).toMatchObject({
      isValid: false,
      invalidReason: 'unexpected_verify_error',
    });
    void facilitator;
  });

  it('settle surfaces unexpected_settle_error when the core verify or settle throws', async () => {
    const verify = vi.fn(async () => {
      throw new Error('rpc exploded');
    });
    expect(await makeFacilitator({ verify }).settle(await makeEnvelope())).toMatchObject({
      success: false,
      errorReason: 'unexpected_settle_error',
    });
    const settle = vi.fn(async () => {
      throw new Error('chain id pin failed');
    });
    expect(await makeFacilitator({ settle }).settle(await makeEnvelope())).toMatchObject({
      success: false,
      errorReason: 'unexpected_settle_error',
    });
  });

  it('rejects a payload-level non-exact scheme as invalid_scheme', async () => {
    const envelope = await makeEnvelope();
    (envelope['paymentPayload'] as Record<string, unknown>)['scheme'] = 'stake';
    expect(await makeFacilitator().verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_scheme',
    });
  });

  it('accepts the network alias in requirements', async () => {
    const facilitator = makeFacilitator();
    const envelope = await makeEnvelope({}, { network: arcTestnet.alias });
    expect(await facilitator.verify(envelope)).toMatchObject({ isValid: true });
  });

  it('reports insufficient_funds when the payer balance is below the authorized value', async () => {
    const facilitator = makeFacilitator({
      publicClient: {
        getChainId: vi.fn(async () => arcTestnet.chainId),
        readContract: vi.fn(async () => 5n),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
      },
    });
    expect(await facilitator.verify(await makeEnvelope())).toMatchObject({
      isValid: false,
      invalidReason: 'insufficient_funds',
    });
  });

  it('an unreadable balance is advisory: verification still succeeds', async () => {
    const facilitator = makeFacilitator({
      publicClient: {
        getChainId: vi.fn(async () => arcTestnet.chainId),
        readContract: vi.fn(async () => {
          throw new Error('rpc down');
        }),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
      },
    });
    expect(await facilitator.verify(await makeEnvelope())).toMatchObject({ isValid: true });
  });

  it('rejects an authorization valid further out than the 24h window', async () => {
    const farFuture = String(Math.floor(Date.now() / 1000) + 48 * 3600);
    const envelope = await makeEnvelope({ validBefore: farFuture });
    expect(await makeFacilitator().verify(envelope)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
    expect(await makeFacilitator().settle(envelope)).toMatchObject({
      success: false,
      errorReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
  });
});
