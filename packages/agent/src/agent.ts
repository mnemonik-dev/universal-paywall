import { createPublicClient, createWalletClient, defineChain, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { stakeVaultAbi, stakeVaultFactoryAbi } from './abi.js';
import { parseGrantRequirements, type GrantRequirements } from './parse402.js';
import { buildAccessProof, proofHeaders, type AccessProof, type Hex } from './proof.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface PayerAgentConfig {
  rpcUrl: string;
  chainId: number;
  payerKey: Hex;
  stakeVaultFactory: Hex;
  usdc: Hex;
  /** Optional fetch override (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export type AgentRequestInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

export interface PayerAgent {
  readonly payer: Hex;
  /** Deterministic (counterfactual) vault address for this payer. */
  vaultAddress(): Promise<Hex>;
  /** Deploys the vault if not already deployed; returns its address. */
  ensureVault(): Promise<Hex>;
  /** approve + deposit `amount` USDC into the vault. */
  deposit(amount: bigint): Promise<void>;
  /** Grants a policy to `facilitator` (cap + unix `validUntil`). */
  grant(facilitator: Hex, cap: bigint, validUntil: number): Promise<void>;
  /** Ensures a vault exists, funds the shortfall, and grants per requirements. */
  ensureGrant(req: GrantRequirements): Promise<void>;
  /** Builds a fresh signed access proof. */
  signAccessProof(): Promise<AccessProof>;
  /**
   * x402 auto-pay: sends the request with a proof; on a `402`, establishes the
   * required grant on-chain and retries once.
   */
  fetchWithPaywall(url: string, init?: AgentRequestInit): Promise<Response>;
}

export function createPayerAgent(config: PayerAgentConfig): PayerAgent {
  const chain = defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const account = privateKeyToAccount(config.payerKey);
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(config.rpcUrl) });
  const doFetch = config.fetchImpl ?? fetch;
  const payer = account.address;

  async function vaultAddress(): Promise<Hex> {
    return (await pub.readContract({
      address: config.stakeVaultFactory,
      abi: stakeVaultFactoryAbi,
      functionName: 'computeVaultAddress',
      args: [payer],
    })) as Hex;
  }

  async function ensureVault(): Promise<Hex> {
    const existing = (await pub.readContract({
      address: config.stakeVaultFactory,
      abi: stakeVaultFactoryAbi,
      functionName: 'vaults',
      args: [payer],
    })) as Hex;
    if (existing.toLowerCase() !== ZERO) return existing;
    const hash = await wallet.writeContract({
      address: config.stakeVaultFactory,
      abi: stakeVaultFactoryAbi,
      functionName: 'createVault',
      args: [payer],
      account,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    return vaultAddress();
  }

  async function deposit(amount: bigint): Promise<void> {
    const vault = await vaultAddress();
    const approveHash = await wallet.writeContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [vault, amount],
      account,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash: approveHash });
    const depositHash = await wallet.writeContract({
      address: vault,
      abi: stakeVaultAbi,
      functionName: 'deposit',
      args: [amount],
      account,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash: depositHash });
  }

  async function grant(facilitator: Hex, cap: bigint, validUntil: number): Promise<void> {
    const vault = await vaultAddress();
    const hash = await wallet.writeContract({
      address: vault,
      abi: stakeVaultAbi,
      functionName: 'grantPolicy',
      args: [facilitator, cap, BigInt(validUntil)],
      account,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });
  }

  async function ensureGrant(req: GrantRequirements): Promise<void> {
    const vault = await ensureVault();
    const have = (await pub.readContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [vault],
    })) as bigint;
    if (have < req.recommendedCap) await deposit(req.recommendedCap - have);
    const validUntil = Math.floor(Date.now() / 1000) + req.validForSeconds;
    await grant(req.facilitator, req.recommendedCap, validUntil);
  }

  async function signAccessProof(): Promise<AccessProof> {
    return buildAccessProof({
      address: payer,
      signMessage: ({ message }) => wallet.signMessage({ account, message }),
    });
  }

  async function fetchWithPaywall(url: string, init: AgentRequestInit = {}): Promise<Response> {
    const proof = await signAccessProof();
    const res = await doFetch(url, { ...init, headers: { ...init.headers, ...proofHeaders(proof) } });
    if (res.status !== 402) return res;

    const body = await res.json().catch(() => null);
    const req = parseGrantRequirements(body);
    if (req === null) return res;

    await ensureGrant(req);
    const proof2 = await signAccessProof();
    return doFetch(url, { ...init, headers: { ...init.headers, ...proofHeaders(proof2) } });
  }

  return {
    payer,
    vaultAddress,
    ensureVault,
    deposit,
    grant,
    ensureGrant,
    signAccessProof,
    fetchWithPaywall,
  };
}
