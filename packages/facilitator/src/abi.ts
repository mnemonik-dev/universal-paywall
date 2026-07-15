/** Minimal ABI fragments the facilitator needs from the rail contracts. */

export const stakeVaultAbi = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'creators', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'policy',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'facilitator', type: 'address' },
      { name: 'cap', type: 'uint256' },
      { name: 'spent', type: 'uint256' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'epoch', type: 'uint64' },
    ],
  },
] as const;

export const stakeVaultFactoryAbi = [
  {
    type: 'function',
    name: 'computeVaultAddress',
    stateMutability: 'view',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'vaults',
    stateMutability: 'view',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const sessionStakeVaultAbi = [
  {
    type: 'function',
    name: 'payer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'grantPolicyBySig',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'grant',
        type: 'tuple',
        components: [
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
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'policy',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'facilitator', type: 'address' },
      { name: 'payTo', type: 'address' },
      { name: 'cap', type: 'uint256' },
      { name: 'spent', type: 'uint256' },
      { name: 'perOperationCeiling', type: 'uint256' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'epoch', type: 'uint64' },
      { name: 'scopeHash', type: 'bytes32' },
      { name: 'revoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'settledOperations',
    stateMutability: 'view',
    inputs: [{ name: 'operationId', type: 'bytes32' }],
    outputs: [{ name: 'settled', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'settleOperation',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operationId', type: 'bytes32' },
      { name: 'policyEpoch', type: 'uint64' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'OperationSettled',
    anonymous: false,
    inputs: [
      { name: 'operationId', type: 'bytes32', indexed: true },
      { name: 'payTo', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'spent', type: 'uint256', indexed: false },
      { name: 'epoch', type: 'uint64', indexed: false },
    ],
  },
] as const;

export const sessionStakeVaultFactoryAbi = [
  {
    type: 'function',
    name: 'vaults',
    stateMutability: 'view',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: 'vault', type: 'address' }],
  },
] as const;

export const erc20BalanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

export const erc20TransferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const eip3009Abi = [
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
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: 'used', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'AuthorizationUsed',
    anonymous: false,
    inputs: [
      { name: 'authorizer', type: 'address', indexed: true },
      { name: 'nonce', type: 'bytes32', indexed: true },
    ],
  },
] as const;
