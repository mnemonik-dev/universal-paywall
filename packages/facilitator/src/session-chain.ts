import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  stringToHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildChain } from './chain.js';
import { sessionScopeHash } from './canonical.js';
import { eip3009Abi, erc20BalanceAbi, sessionStakeVaultAbi } from './abi.js';
import type {
  ExactAuthorization,
  ExactPaymentSettler,
  OperationBinding,
  SessionOperationSettler,
  SessionPolicy,
  SessionPolicyReader,
  SessionPolicyRegistrar,
  RegisterSessionRequest,
  SettlementInput,
  SettlementResult,
} from './session-types.js';

export interface SessionChainConfig {
  rpcUrl: string;
  chainId: number;
  facilitatorKey: Hex;
  asset: Hex;
  fromBlock?: bigint;
}

function classify(error: unknown): SettlementResult {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|socket|network|fetch/i.test(message)) {
    return { status: 'uncertain', reason: 'settlement_uncertain' };
  }
  if (/OperationAlreadySettled/i.test(message)) {
    return { status: 'uncertain', reason: 'operation_already_settled_reconcile_required' };
  }
  if (/PolicyRevoked/i.test(message)) return { status: 'failed', reason: 'session_revoked' };
  if (/PolicyExpired/i.test(message)) return { status: 'failed', reason: 'session_expired' };
  if (/CapExceeded/i.test(message)) return { status: 'failed', reason: 'session_cap_exceeded' };
  return { status: 'failed', reason: 'settlement_failed' };
}

export class OnChainSessionPayments
  implements SessionPolicyReader, SessionPolicyRegistrar, SessionOperationSettler
{
  readonly #account: ReturnType<typeof privateKeyToAccount>;
  readonly #wallet: ReturnType<typeof createWalletClient>;
  readonly #public: ReturnType<typeof createPublicClient>;
  readonly #asset: Hex;
  readonly #fromBlock: bigint;

  constructor(config: SessionChainConfig) {
    const chain = buildChain(config.chainId, config.rpcUrl);
    this.#account = privateKeyToAccount(config.facilitatorKey);
    this.#wallet = createWalletClient({
      account: this.#account,
      chain,
      transport: http(config.rpcUrl),
    });
    this.#public = createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.#asset = config.asset;
    this.#fromBlock = config.fromBlock ?? 0n;
  }

  async read(vault: Hex): Promise<SessionPolicy> {
    const [raw, balance] = await Promise.all([
      this.#public.readContract({
        address: vault,
        abi: sessionStakeVaultAbi,
        functionName: 'policy',
      }),
      this.#public.readContract({
        address: this.#asset,
        abi: erc20BalanceAbi,
        functionName: 'balanceOf',
        args: [vault],
      }),
    ]);
    return {
      facilitator: raw[0],
      pay_to: raw[1],
      cap: raw[2],
      spent: raw[3],
      per_operation_ceiling: raw[4],
      valid_until: raw[5],
      epoch: raw[6],
      scope_hash: raw[7],
      revoked: raw[8],
      funded_balance: balance,
    };
  }

  async register(request: RegisterSessionRequest): Promise<{ tx_hash: Hex }> {
    const auth = request.authorization;
    const txHash = await this.#wallet.writeContract({
      address: auth.vault,
      abi: sessionStakeVaultAbi,
      functionName: 'grantPolicyBySig',
      args: [
        {
          sessionIdHash: keccak256(stringToHex(auth.session_id)),
          payerWallet: auth.payer_wallet,
          vault: auth.vault,
          facilitator: auth.facilitator,
          payTo: auth.pay_to,
          cap: BigInt(auth.cap),
          perOperationCeiling: BigInt(auth.per_operation_ceiling),
          validUntil: BigInt(Math.floor(Date.parse(auth.valid_until) / 1000)),
          asset: auth.asset,
          policyEpoch: BigInt(auth.policy_epoch),
          scopeHash: sessionScopeHash(auth),
          nonce: auth.nonce,
        },
        request.signature,
      ],
      account: this.#account,
      chain: this.#wallet.chain,
    });
    const receipt = await this.#public.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') throw new Error('session_registration_reverted');
    return { tx_hash: txHash };
  }

  async settle(input: SettlementInput): Promise<SettlementResult> {
    try {
      const txHash = await this.#wallet.writeContract({
        address: input.vault,
        abi: sessionStakeVaultAbi,
        functionName: 'settleOperation',
        args: [input.operation_id, input.policy_epoch, input.amount],
        account: this.#account,
        chain: this.#wallet.chain,
      });
      const receipt = await this.#public.waitForTransactionReceipt({
        hash: txHash,
        timeout: 30_000,
      });
      return receipt.status === 'success'
        ? { status: 'settled', tx_hash: txHash }
        : { status: 'failed', reason: 'receipt_reverted' };
    } catch (error) {
      return classify(error);
    }
  }

  async reconcile(input: SettlementInput): Promise<{ settled: boolean; tx_hash?: Hex }> {
    const settled = await this.#public.readContract({
      address: input.vault,
      abi: sessionStakeVaultAbi,
      functionName: 'settledOperations',
      args: [input.operation_id],
    });
    if (!settled) return { settled: false };
    const events = await this.#public.getContractEvents({
      address: input.vault,
      abi: sessionStakeVaultAbi,
      eventName: 'OperationSettled',
      args: { operationId: input.operation_id },
      fromBlock: this.#fromBlock,
      toBlock: 'latest',
    });
    const event = events.at(-1);
    return event === undefined
      ? { settled: true }
      : { settled: true, tx_hash: event.transactionHash };
  }
}

export interface ExactChainConfig {
  rpcUrl: string;
  chainId: number;
  facilitatorKey: Hex;
  asset: Hex;
  eip712Name: string;
  eip712Version: string;
  fromBlock?: bigint;
}

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export class OnChainExactPayments implements ExactPaymentSettler {
  readonly #account: ReturnType<typeof privateKeyToAccount>;
  readonly #wallet: ReturnType<typeof createWalletClient>;
  readonly #public: ReturnType<typeof createPublicClient>;
  readonly #config: ExactChainConfig;
  readonly #fromBlock: bigint;

  constructor(config: ExactChainConfig) {
    const chain = buildChain(config.chainId, config.rpcUrl);
    this.#account = privateKeyToAccount(config.facilitatorKey);
    this.#wallet = createWalletClient({
      account: this.#account,
      chain,
      transport: http(config.rpcUrl),
    });
    this.#public = createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.#config = config;
    this.#fromBlock = config.fromBlock ?? 0n;
  }

  async settle(binding: OperationBinding, proof: ExactAuthorization): Promise<SettlementResult> {
    const authorization = proof.authorization;
    let recovered: Hex;
    try {
      recovered = await recoverTypedDataAddress({
        domain: {
          name: this.#config.eip712Name,
          version: this.#config.eip712Version,
          chainId: this.#config.chainId,
          verifyingContract: this.#config.asset,
        },
        types: TRANSFER_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature: proof.signature,
      });
    } catch {
      return { status: 'failed', reason: 'invalid_exact_signature' };
    }
    if (recovered.toLowerCase() !== binding.payer_wallet.toLowerCase()) {
      return { status: 'failed', reason: 'invalid_exact_signature' };
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(authorization.validAfter) > now || BigInt(authorization.validBefore) <= now) {
      return { status: 'failed', reason: 'exact_authorization_expired' };
    }
    let signature: ReturnType<typeof parseSignature>;
    try {
      signature = parseSignature(proof.signature);
    } catch {
      return { status: 'failed', reason: 'invalid_exact_signature' };
    }
    const yParity =
      signature.yParity ?? (signature.v === undefined ? undefined : Number(signature.v) - 27);
    if (yParity === undefined) return { status: 'failed', reason: 'invalid_exact_signature' };
    try {
      const txHash = await this.#wallet.writeContract({
        address: this.#config.asset,
        abi: eip3009Abi,
        functionName: 'transferWithAuthorization',
        args: [
          authorization.from,
          authorization.to,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce,
          27 + yParity,
          signature.r,
          signature.s,
        ],
        account: this.#account,
        chain: this.#wallet.chain,
      });
      const receipt = await this.#public.waitForTransactionReceipt({
        hash: txHash,
        timeout: 30_000,
      });
      return receipt.status === 'success'
        ? { status: 'settled', tx_hash: txHash }
        : { status: 'failed', reason: 'receipt_reverted' };
    } catch (error) {
      return classify(error);
    }
  }

  async reconcile(
    _binding: OperationBinding,
    proof: ExactAuthorization,
  ): Promise<{ settled: boolean; tx_hash?: Hex }> {
    const used = await this.#public.readContract({
      address: this.#config.asset,
      abi: eip3009Abi,
      functionName: 'authorizationState',
      args: [proof.authorization.from, proof.authorization.nonce],
    });
    if (!used) return { settled: false };
    const events = await this.#public.getContractEvents({
      address: this.#config.asset,
      abi: eip3009Abi,
      eventName: 'AuthorizationUsed',
      args: { authorizer: proof.authorization.from, nonce: proof.authorization.nonce },
      fromBlock: this.#fromBlock,
      toBlock: 'latest',
    });
    const event = events.at(-1);
    return event === undefined
      ? { settled: true }
      : { settled: true, tx_hash: event.transactionHash };
  }
}
