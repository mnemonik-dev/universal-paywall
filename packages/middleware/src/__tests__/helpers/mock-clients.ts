import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { PublicClientLike } from '../../settle.js';

export interface MockPublicClientShape extends PublicClientLike {
  getChainId: Mock<[], Promise<number>>;
  readContract: Mock<[unknown], Promise<unknown>>;
  waitForTransactionReceipt: Mock<[unknown], Promise<{ status: 'success' | 'reverted' }>>;
}

export interface MockPublicClientConfig {
  chainId?: number;
  usdcBalance?: bigint | unknown;
  paused?: boolean;
  vaults?: `0x${string}`;
  receipt?: { status: 'success' | 'reverted' };
}

/**
 * Configurable PublicClient stub covering every method `verify.ts`,
 * `settle.ts`, and `core.ts` actually call. Tests override individual
 * mock implementations after construction to drive failure branches.
 */
export function makeMockPublicClient(cfg: MockPublicClientConfig = {}): MockPublicClientShape {
  const chainId = cfg.chainId ?? 5042002;
  const balance = cfg.usdcBalance ?? 10_000_000n;
  const paused = cfg.paused ?? false;
  const vaults = cfg.vaults ?? ('0x2222222222222222222222222222222222222222' as `0x${string}`);
  const receipt = cfg.receipt ?? { status: 'success' as const };

  const getChainId = vi.fn(async () => chainId);
  const readContract = vi.fn(async (args: unknown) => {
    const fname = (args as { functionName: string }).functionName;
    if (fname === 'balanceOf') return balance;
    if (fname === 'paused') return paused;
    if (fname === 'vaults') return vaults;
    throw new Error(`mock readContract: unhandled functionName ${fname}`);
  });
  const waitForTransactionReceipt = vi.fn(async () => receipt);

  return { getChainId, readContract, waitForTransactionReceipt };
}

export interface MockWalletClientShape {
  writeContract: Mock<[unknown], Promise<`0x${string}`>>;
}

export function makeMockWalletClient(
  defaultTxHash: `0x${string}` = ('0x' + 'fe'.repeat(32)) as `0x${string}`,
): MockWalletClientShape {
  return {
    writeContract: vi.fn(async () => defaultTxHash),
  };
}
