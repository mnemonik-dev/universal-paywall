import { privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from '../../networks.js';
import type { PaymentPayload } from '../../types.js';

const DEFAULT_PK = ('0x' + '11'.repeat(31) + '12') as `0x${string}`;

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

export interface SignOverrides {
  privateKey?: `0x${string}`;
  to?: `0x${string}`;
  value?: string;
  validAfterSec?: number;
  validBeforeSec?: number;
  network?: string;
  nonce?: `0x${string}`;
  domain?: Partial<{
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  }>;
}

export interface SignResult {
  payload: PaymentPayload;
  signerAddress: `0x${string}`;
  privateKey: `0x${string}`;
}

const DEFAULT_VAULT: `0x${string}` = '0x2222222222222222222222222222222222222222';
const DEFAULT_NONCE: `0x${string}` = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

/**
 * Produces a signed EIP-3009 TransferWithAuthorization payload for the
 * arc-testnet domain. Tests pass `overrides` to mutate one field at a time
 * (the tamper matrix). Returns the signer address so tests can configure
 * `expectedVaultAddress` or factory mocks without re-deriving it.
 */
export async function signFreshAuth(overrides: SignOverrides = {}): Promise<SignResult> {
  const pk = overrides.privateKey ?? DEFAULT_PK;
  const account = privateKeyToAccount(pk);
  const arcTestnet = NETWORKS['arc-testnet'];
  const domain = {
    name: overrides.domain?.name ?? arcTestnet.usdcEip712Name,
    version: overrides.domain?.version ?? arcTestnet.usdcEip712Version,
    chainId: overrides.domain?.chainId ?? arcTestnet.chainId,
    verifyingContract: overrides.domain?.verifyingContract ?? arcTestnet.usdcAddress,
  } as const;
  const authorization = {
    from: account.address,
    to: overrides.to ?? DEFAULT_VAULT,
    value: overrides.value ?? '10000',
    validAfter: String(overrides.validAfterSec ?? 0),
    validBefore: String(overrides.validBeforeSec ?? 9_999_999_999),
    nonce: overrides.nonce ?? DEFAULT_NONCE,
  } as const;
  const signature = await account.signTypedData({
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
    payload: {
      x402Version: 1,
      scheme: 'exact',
      network: overrides.network ?? arcTestnet.id,
      payload: { signature, authorization },
    },
    signerAddress: account.address,
    privateKey: pk,
  };
}
