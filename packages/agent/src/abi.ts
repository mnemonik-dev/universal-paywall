/** Minimal rail ABI fragments the payer agent calls. (USDC uses viem's erc20Abi.) */

export const stakeVaultFactoryAbi = [
  {
    type: 'function',
    name: 'vaults',
    stateMutability: 'view',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createVault',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: 'vault', type: 'address' }],
  },
  {
    type: 'function',
    name: 'computeVaultAddress',
    stateMutability: 'view',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const stakeVaultAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'grantPolicy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'facilitator', type: 'address' },
      { name: 'cap', type: 'uint256' },
      { name: 'validUntil', type: 'uint64' },
    ],
    outputs: [],
  },
] as const;
