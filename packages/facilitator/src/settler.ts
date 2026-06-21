import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildChain } from './chain.js';
import { stakeVaultAbi, stakeVaultFactoryAbi } from './abi.js';
import type { FacilitatorConfig, Hex, SettleResult, SettlementBatch, Settler, VaultResolver } from './types.js';

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient funds|no_balance|exceeds balance/i.test(msg)) return 'relayer_no_balance';
  if (/CapExceeded/i.test(msg)) return 'cap_exceeded';
  if (/PolicyExpired/i.test(msg)) return 'policy_expired';
  if (/NotFacilitator/i.test(msg)) return 'not_authorized';
  if (/timeout/i.test(msg)) return 'rpc_timeout';
  return 'settle_failed';
}

/**
 * viem-backed settler: signs `StakeVault.settle()` with the facilitator session
 * key and pays gas. The raw key lives only inside this module.
 */
export class OnChainSettler implements Settler {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly wallet: ReturnType<typeof createWalletClient>;
  private readonly pub: ReturnType<typeof createPublicClient>;

  constructor(config: FacilitatorConfig) {
    const chain = buildChain(config.chainId, config.rpcUrl);
    this.account = privateKeyToAccount(config.facilitatorKey);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(config.rpcUrl) });
    this.pub = createPublicClient({ chain, transport: http(config.rpcUrl) });
  }

  async settle(batch: SettlementBatch): Promise<SettleResult> {
    if (batch.creators.length === 0) return { ok: true };
    try {
      const hash = await this.wallet.writeContract({
        address: batch.vault,
        abi: stakeVaultAbi,
        functionName: 'settle',
        args: [batch.creators, batch.amounts],
        account: this.account,
        chain: this.wallet.chain,
      });
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
      return receipt.status === 'success'
        ? { ok: true, txHash: hash }
        : { ok: false, txHash: hash, reason: 'receipt_reverted' };
    } catch (err) {
      return { ok: false, reason: classifyError(err) };
    }
  }
}

/**
 * Resolves a payer to its counterfactual vault address via the factory's
 * `computeVaultAddress` view, cached per process.
 */
export function createVaultResolver(config: FacilitatorConfig): VaultResolver {
  const chain = buildChain(config.chainId, config.rpcUrl);
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const cache = new Map<Hex, Hex>();

  return async (payer: Hex): Promise<Hex> => {
    const cached = cache.get(payer);
    if (cached !== undefined) return cached;
    const vault = (await pub.readContract({
      address: config.stakeVaultFactory,
      abi: stakeVaultFactoryAbi,
      functionName: 'computeVaultAddress',
      args: [payer],
    })) as Hex;
    cache.set(payer, vault);
    return vault;
  };
}
