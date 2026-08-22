import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { PaymentPayload } from '../types.js';
import { NETWORKS } from '../networks.js';
import { NonceStore } from '../replay-store.js';
import { verifyEip3009Authorization } from '../verify.js';

// Stable signer used across tests. The address is derived deterministically
// from this private key.
const SIGNER_PK = ('0x' + '11'.repeat(31) + '12') as `0x${string}`;
const signer = privateKeyToAccount(SIGNER_PK);

const VAULT_ADDR: `0x${string}` = '0x2222222222222222222222222222222222222222';
const OTHER_ADDR: `0x${string}` = '0x3333333333333333333333333333333333333333';
const NONCE: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

// Reference network row (arc-testnet); cloned for tamper tests.
const arcTestnet = NETWORKS['arc-testnet'];

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

async function makePayload(
  overrides: {
    to?: `0x${string}`;
    value?: string;
    validAfterSec?: number;
    validBeforeSec?: number;
    network?: string;
    nonce?: `0x${string}`;
    domain?: {
      name?: string;
      version?: string;
      chainId?: number;
      verifyingContract?: `0x${string}`;
    };
  } = {},
): Promise<PaymentPayload> {
  const domain = {
    name: overrides.domain?.name ?? arcTestnet.usdcEip712Name,
    version: overrides.domain?.version ?? arcTestnet.usdcEip712Version,
    chainId: overrides.domain?.chainId ?? arcTestnet.chainId,
    verifyingContract: overrides.domain?.verifyingContract ?? arcTestnet.usdcAddress,
  } as const;
  const authorization = {
    from: signer.address,
    to: overrides.to ?? VAULT_ADDR,
    value: overrides.value ?? '10000',
    validAfter: String(overrides.validAfterSec ?? 0),
    validBefore: String(overrides.validBeforeSec ?? 9_999_999_999),
    nonce: overrides.nonce ?? NONCE,
  } as const;
  const signature = await signer.signTypedData({
    domain,
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
    network: overrides.network ?? arcTestnet.id,
    payload: { signature, authorization },
  };
}

function freshOpts() {
  return {
    expectedVaultAddress: VAULT_ADDR,
    expectedNetwork: arcTestnet.alias,
    maxAmountRequired: 10_000n,
    publicClient: {} as never,
    nonceStore: new NonceStore(),
    nowMs: 1_700_000_000_000,
  };
}

describe('verifyEip3009Authorization', () => {
  it('valid signature passes', async () => {
    const payload = await makePayload();
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: true, recoveredFrom: signer.address });
  });

  it('tampered chainId fails as invalid_signature', async () => {
    const payload = await makePayload({
      domain: { chainId: arcTestnet.chainId + 1 },
    });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('tampered verifyingContract fails as invalid_signature', async () => {
    const payload = await makePayload({
      domain: {
        verifyingContract: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`,
      },
    });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('tampered domain.name fails as invalid_signature', async () => {
    const payload = await makePayload({ domain: { name: 'NOT-USDC' } });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('tampered domain.version fails as invalid_signature', async () => {
    const payload = await makePayload({ domain: { version: '999' } });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('to mismatch fails as to_mismatch', async () => {
    const payload = await makePayload({ to: OTHER_ADDR });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'to_mismatch' });
  });

  it('value below required fails as insufficient_amount', async () => {
    const payload = await makePayload({ value: '9999' });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'insufficient_amount' });
  });

  it('validBefore at nowSec + 4 fails as authorization_expired (within 5s safety margin)', async () => {
    const opts = freshOpts();
    const nowSec = Math.floor(opts.nowMs / 1000);
    const payload = await makePayload({ validBeforeSec: nowSec + 4 });
    const result = await verifyEip3009Authorization(payload, opts);
    expect(result).toEqual({ ok: false, reason: 'authorization_expired' });
  });

  it('validBefore at nowSec + 5 (exact boundary) fails — guard is `<=`', async () => {
    // Fence-post: validBeforeMs == nowMs + SAFETY_MARGIN_MS must reject.
    // Confirms the comparison is `<=`, not strict `<`.
    const opts = freshOpts();
    const nowSec = Math.floor(opts.nowMs / 1000);
    const payload = await makePayload({ validBeforeSec: nowSec + 5 });
    const result = await verifyEip3009Authorization(payload, opts);
    expect(result).toEqual({ ok: false, reason: 'authorization_expired' });
  });

  it('validBefore at nowSec + 6 passes the safety margin', async () => {
    const opts = freshOpts();
    const nowSec = Math.floor(opts.nowMs / 1000);
    const payload = await makePayload({ validBeforeSec: nowSec + 6 });
    const result = await verifyEip3009Authorization(payload, opts);
    expect(result).toEqual({ ok: true, recoveredFrom: signer.address });
  });

  it('validAfter in future fails as authorization_not_yet_valid', async () => {
    const opts = freshOpts();
    const nowSec = Math.floor(opts.nowMs / 1000);
    const payload = await makePayload({
      validAfterSec: nowSec + 60,
      validBeforeSec: nowSec + 3600,
    });
    const result = await verifyEip3009Authorization(payload, opts);
    expect(result).toEqual({
      ok: false,
      reason: 'authorization_not_yet_valid',
    });
  });

  it('network mismatch fails as network_mismatch', async () => {
    const payload = await makePayload({ network: 'arc-mainnet' });
    const result = await verifyEip3009Authorization(payload, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'network_mismatch' });
  });

  it('CAIP-2 and alias normalize equal', async () => {
    // payload uses CAIP-2 form, opts uses alias
    const payload = await makePayload({ network: 'eip155:5042002' });
    const result = await verifyEip3009Authorization(payload, {
      ...freshOpts(),
      expectedNetwork: 'arc-testnet',
    });
    expect(result).toEqual({ ok: true, recoveredFrom: signer.address });
  });

  it('nonce store uses checkAndInsert (production primitive), NOT raw has+insert', async () => {
    const payload = await makePayload();
    const opts = freshOpts();
    const hasSpy = vi.spyOn(opts.nonceStore, 'has');
    const insertSpy = vi.spyOn(opts.nonceStore, 'insert');
    const checkSpy = vi.spyOn(opts.nonceStore, 'checkAndInsert');
    const result = await verifyEip3009Authorization(payload, opts);
    expect(result).toEqual({ ok: true, recoveredFrom: signer.address });
    // `checkAndInsert` is the atomic, TOCTOU-safe primitive documented in
    // replay-store.ts; `insert` is marked test-only. verify.ts must call
    // checkAndInsert and only checkAndInsert.
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(checkSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: signer.address,
        nonce: NONCE,
      }),
    );
    expect(hasSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('duplicate nonce rejected as nonce_already_used', async () => {
    const opts = freshOpts();
    const payload = await makePayload();
    const first = await verifyEip3009Authorization(payload, opts);
    expect(first.ok).toBe(true);
    // second call with same payload (same from + nonce)
    const payload2 = await makePayload();
    const second = await verifyEip3009Authorization(payload2, opts);
    expect(second).toEqual({ ok: false, reason: 'nonce_already_used' });
  });

  it('unknown expected network returns network_mismatch (defensive branch)', async () => {
    const payload = await makePayload();
    const result = await verifyEip3009Authorization(payload, {
      ...freshOpts(),
      expectedNetwork: 'unknown-chain-xyz',
    });
    expect(result).toEqual({ ok: false, reason: 'network_mismatch' });
  });

  it('malformed signature surfaces as invalid_signature (recoverTypedDataAddress throws)', async () => {
    const payload = await makePayload();
    // Replace signature with a 130-hex blob that parses shape-wise but
    // viem's recoverTypedDataAddress refuses (invalid s component for ECDSA).
    const tampered = {
      ...payload,
      payload: {
        ...payload.payload,
        signature: ('0x' + 'ff'.repeat(65)) as `0x${string}`,
      },
    };
    const result = await verifyEip3009Authorization(tampered, freshOpts());
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('default nowMs uses Date.now() when not provided', async () => {
    const payload = await makePayload();
    const opts = freshOpts();
    // Build opts WITHOUT nowMs so verify.ts falls back to Date.now().
    const noNowOpts: typeof opts = { ...opts };
    delete (noNowOpts as Record<string, unknown>)['nowMs'];
    const result = await verifyEip3009Authorization(payload, noNowOpts);
    expect(result).toEqual({ ok: true, recoveredFrom: signer.address });
  });
});
