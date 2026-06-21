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
