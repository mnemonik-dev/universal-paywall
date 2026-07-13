import { recoverTypedDataAddress, stringToHex, keccak256, type Hex } from 'viem';
import { canonicalJson, sessionScopeHash } from './canonical.js';
import type { RegisterSessionRequest, SessionAuthorization } from './session-types.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

export interface SessionVerifierConfig {
  serviceId: string;
  network: string;
  chainId: number;
  asset: Hex;
  facilitator: Hex;
  payTo: Hex;
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function unixSeconds(input: string): bigint {
  const millis = Date.parse(input);
  if (!Number.isFinite(millis)) throw new Error('invalid_valid_until');
  return BigInt(Math.floor(millis / 1000));
}

export function allowedActionsHash(auth: SessionAuthorization): Hex {
  return keccak256(stringToHex(canonicalJson(auth.allowed_actions)));
}

export function sessionTypedData(auth: SessionAuthorization, config: SessionVerifierConfig) {
  return {
    domain: {
      name: 'Universal Paywall Session',
      version: '1',
      chainId: config.chainId,
      verifyingContract: auth.vault,
    },
    types: {
      SessionAuthorization: [
        { name: 'sessionIdHash', type: 'bytes32' },
        { name: 'payerWallet', type: 'address' },
        { name: 'vault', type: 'address' },
        { name: 'facilitator', type: 'address' },
        { name: 'payTo', type: 'address' },
        { name: 'cap', type: 'uint256' },
        { name: 'perOperationCeiling', type: 'uint256' },
        { name: 'validUntil', type: 'uint64' },
        { name: 'asset', type: 'address' },
        { name: 'policyEpoch', type: 'uint64' },
        { name: 'scopeHash', type: 'bytes32' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'SessionAuthorization' as const,
    message: {
      sessionIdHash: keccak256(stringToHex(auth.session_id)),
      payerWallet: auth.payer_wallet,
      vault: auth.vault,
      facilitator: auth.facilitator,
      payTo: auth.pay_to,
      cap: BigInt(auth.cap),
      perOperationCeiling: BigInt(auth.per_operation_ceiling),
      validUntil: unixSeconds(auth.valid_until),
      asset: auth.asset,
      policyEpoch: BigInt(auth.policy_epoch),
      scopeHash: sessionScopeHash(auth),
      nonce: auth.nonce,
    },
  } as const;
}

export async function verifySessionAuthorization(
  request: RegisterSessionRequest,
  config: SessionVerifierConfig,
): Promise<{ scopeHash: Hex; validUntil: bigint }> {
  const auth = request.authorization;
  if (auth.version !== 1) throw new Error('unsupported_session_version');
  if (auth.service_id !== config.serviceId) throw new Error('service_mismatch');
  if (auth.network !== config.network) throw new Error('network_mismatch');
  if (!sameHex(auth.asset, config.asset)) throw new Error('asset_mismatch');
  if (!sameHex(auth.facilitator, config.facilitator)) throw new Error('facilitator_mismatch');
  if (!sameHex(auth.pay_to, config.payTo)) throw new Error('payee_mismatch');
  for (const value of [auth.payer_wallet, auth.vault, auth.asset, auth.facilitator, auth.pay_to]) {
    if (!ADDRESS_RE.test(value)) throw new Error('invalid_address');
  }
  if (!BYTES32_RE.test(auth.workspace_hash) || !BYTES32_RE.test(auth.nonce)) {
    throw new Error('invalid_bytes32');
  }
  for (const value of [auth.cap, auth.per_operation_ceiling, auth.policy_epoch]) {
    if (!UINT_RE.test(value)) throw new Error('invalid_integer');
  }
  if (BigInt(auth.cap) === 0n || BigInt(auth.per_operation_ceiling) === 0n) {
    throw new Error('zero_session_limit');
  }
  if (BigInt(auth.per_operation_ceiling) > BigInt(auth.cap)) {
    throw new Error('ceiling_exceeds_cap');
  }
  if (
    auth.allowed_actions.length === 0 ||
    new Set(auth.allowed_actions).size !== auth.allowed_actions.length
  ) {
    throw new Error('invalid_allowed_actions');
  }

  const validUntil = unixSeconds(auth.valid_until);
  const recovered = await recoverTypedDataAddress({
    ...sessionTypedData(auth, config),
    signature: request.signature,
  });
  if (!sameHex(recovered, auth.payer_wallet)) throw new Error('invalid_session_signature');
  return { scopeHash: sessionScopeHash(auth), validUntil };
}
