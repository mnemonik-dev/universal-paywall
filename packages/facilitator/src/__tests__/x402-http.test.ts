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
  overrides: { value?: string; nonce?: `0x${string}` } = {},
): Promise<Record<string, unknown>> {
  const authorization = {
    from: signer.address,
    to: VAULT_ADDR,
    value: overrides.value ?? '10000',
    validAfter: '0',
    validBefore: '9999999999',
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
  payloadOverrides: { value?: string; nonce?: `0x${string}` } = {},
  requirementsOverrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    x402Version: 1,
    paymentPayload: await makePaymentPayload(payloadOverrides),
    paymentRequirements: makeRequirements(requirementsOverrides),
  };
}

function makeFacilitator(
  opts: { settle?: ReturnType<typeof vi.fn>; verify?: ReturnType<typeof vi.fn> } = {},
): X402Facilitator {
  const deps: Record<string, unknown> = {};
  if (opts.settle) deps['settle'] = opts.settle;
  if (opts.verify) deps['verify'] = opts.verify;
  return new X402Facilitator({
    network: arcTestnet,
    relayerKey: new OpaqueRelayerKey(RELAYER_PK),
    relayerAddress: RELAYER_ADDR,
    publicClient: {
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
