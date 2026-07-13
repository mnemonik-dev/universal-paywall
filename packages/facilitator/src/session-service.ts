import { canonicalJson, operationDigest, sessionScopeHash, sha256Digest } from './canonical.js';
import type { FilePaymentStore, StoredPayment } from './payment-store.js';
import { ReceiptSigner } from './receipt.js';
import { verifySessionAuthorization, type SessionVerifierConfig } from './session-auth.js';
import type {
  ExactPaymentSettler,
  OperationBinding,
  PaidSession,
  PaymentReceipt,
  ProviderPaymentStatus,
  RegisterSessionRequest,
  SessionOperationSettler,
  SessionPolicy,
  SessionPolicyReader,
  SessionPolicyRegistrar,
  SettleRequest,
  SettlementInput,
} from './session-types.js';
import type { Hex } from './types.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

export class PaymentServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'PaymentServiceError';
  }
}

export interface SessionPaymentServiceConfig extends SessionVerifierConfig {
  quoteTtlSeconds: number;
}

export interface SessionPaymentServiceOptions {
  config: SessionPaymentServiceConfig;
  store: FilePaymentStore;
  policyReader: SessionPolicyReader;
  sessionRegistrar?: SessionPolicyRegistrar;
  sessionSettler: SessionOperationSettler;
  exactSettler?: ExactPaymentSettler;
  receiptSigner: ReceiptSigner;
  now?: () => Date;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fail(code: string, status = 400): never {
  throw new PaymentServiceError(code, status);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export class SessionPaymentService {
  readonly #config: SessionPaymentServiceConfig;
  readonly #store: FilePaymentStore;
  readonly #policyReader: SessionPolicyReader;
  readonly #sessionRegistrar: SessionPolicyRegistrar | undefined;
  readonly #sessionSettler: SessionOperationSettler;
  readonly #exactSettler: ExactPaymentSettler | undefined;
  readonly #receiptSigner: ReceiptSigner;
  readonly #now: () => Date;
  readonly #inflight = new Map<string, Promise<PaymentReceipt>>();

  constructor(opts: SessionPaymentServiceOptions) {
    this.#config = opts.config;
    this.#store = opts.store;
    this.#policyReader = opts.policyReader;
    this.#sessionRegistrar = opts.sessionRegistrar;
    this.#sessionSettler = opts.sessionSettler;
    this.#exactSettler = opts.exactSettler;
    this.#receiptSigner = opts.receiptSigner;
    this.#now = opts.now ?? (() => new Date());
  }

  receiptKey(): { key_id: string; algorithm: 'Ed25519'; public_key_pem: string } {
    return {
      key_id: this.#receiptSigner.keyId(),
      algorithm: 'Ed25519',
      public_key_pem: this.#receiptSigner.publicKeyPem(),
    };
  }

  createQuote(binding: OperationBinding): {
    quote_id: string;
    binding: OperationBinding;
    binding_digest: Hex;
    accepts: Array<Record<string, unknown>>;
  } {
    this.#validateBinding(binding);
    const digest = operationDigest(binding);
    const existing = this.#store.getQuote(binding.operation_id);
    if (existing !== undefined && existing.binding_digest !== digest) {
      fail('operation_id_conflict', 409);
    }
    const quoteId = existing?.quote_id ?? `q_${digest.slice(2, 18)}`;
    if (existing === undefined) {
      this.#store.putQuote(binding.operation_id, {
        quote_id: quoteId,
        binding,
        binding_digest: digest,
        created_at: this.#now().toISOString(),
      });
    }
    return {
      quote_id: quoteId,
      binding,
      binding_digest: digest,
      accepts: [
        { scheme: 'stake', protocol: 'universal-paywall-session-v1' },
        ...(this.#exactSettler === undefined
          ? []
          : [{ scheme: 'exact', protocol: 'x402', authorization: 'eip3009' }]),
      ],
    };
  }

  async registerSession(request: RegisterSessionRequest): Promise<PaidSession> {
    let verified: Awaited<ReturnType<typeof verifySessionAuthorization>>;
    try {
      verified = await verifySessionAuthorization(request, this.#config);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'invalid_session_authorization', 422);
    }
    const auth = request.authorization;
    if (verified.validUntil <= BigInt(Math.floor(this.#now().getTime() / 1000))) {
      fail('session_expired', 422);
    }
    let policy = await this.#policyReader.read(auth.vault);
    try {
      this.#assertPolicy(auth, policy, verified.scopeHash, verified.validUntil);
    } catch (error) {
      if (
        !(error instanceof PaymentServiceError) ||
        error.code !== 'onchain_policy_mismatch' ||
        this.#sessionRegistrar === undefined
      ) {
        throw error;
      }
      try {
        await this.#sessionRegistrar.register(request);
      } catch {
        fail('session_registration_failed', 503);
      }
      policy = await this.#policyReader.read(auth.vault);
      this.#assertPolicy(auth, policy, verified.scopeHash, verified.validUntil);
    }

    const digest = sha256Digest(request);
    const existing = this.#store.getSession(auth.session_id);
    if (existing !== undefined) {
      if (existing.digest !== digest) fail('session_id_conflict', 409);
      return this.#sessionView(existing.request, policy, existing.created_at);
    }
    const createdAt = this.#now().toISOString();
    this.#store.putSession(auth.session_id, { request, digest, created_at: createdAt });
    return this.#sessionView(request, policy, createdAt);
  }

  async getSession(sessionId: string): Promise<PaidSession> {
    const stored = this.#store.getSession(sessionId);
    if (stored === undefined) fail('session_not_found', 404);
    const policy = await this.#policyReader.read(stored.request.authorization.vault);
    return this.#sessionView(stored.request, policy, stored.created_at);
  }

  settle(request: SettleRequest): Promise<PaymentReceipt> {
    const operationId = request.binding.operation_id;
    const running = this.#inflight.get(operationId);
    if (running !== undefined) return running;
    const promise = this.#settle(request).finally(() => this.#inflight.delete(operationId));
    this.#inflight.set(operationId, promise);
    return promise;
  }

  async getPaymentStatus(operationId: string): Promise<ProviderPaymentStatus> {
    const stored = this.#store.getPayment(operationId);
    if (stored === undefined) fail('payment_not_found', 404);
    if (stored.state === 'settling' || stored.state === 'failed_retryable') {
      const reconciled = await this.#reconcileStored(stored);
      if (reconciled !== undefined) {
        return { operation_id: operationId, status: 'settled', receipt: reconciled };
      }
    }
    return {
      operation_id: operationId,
      status: stored.state,
      ...(stored.receipt !== undefined ? { receipt: stored.receipt } : {}),
      ...(stored.error !== undefined ? { error: stored.error } : {}),
    };
  }

  async #reconcileStored(stored: StoredPayment): Promise<PaymentReceipt | undefined> {
    const payment = stored.payment;
    const result =
      payment.scheme === 'stake'
        ? await this.#sessionSettler.reconcile({
            vault: this.#sessionVault(payment.session_id),
            operation_id: stored.binding_digest as Hex,
            policy_epoch: this.#sessionEpoch(payment.session_id),
            amount: BigInt(stored.binding.amount),
          })
        : await this.#requireExact().reconcile(stored.binding, payment.authorization);
    if (result.settled && result.tx_hash !== undefined) {
      return this.#recordReceipt(stored, result.tx_hash);
    }
    return undefined;
  }

  async #settle(request: SettleRequest): Promise<PaymentReceipt> {
    const { binding, payment } = request;
    this.#validateBinding(binding);
    this.#validatePayment(request);
    if (!same(payment.payer_wallet, binding.payer_wallet)) fail('payer_wallet_mismatch', 422);
    const digest = operationDigest(binding);
    const quote = this.#store.getQuote(binding.operation_id);
    if (quote === undefined) fail('quote_required', 428);
    if (
      quote.binding_digest !== digest ||
      canonicalJson(quote.binding) !== canonicalJson(binding)
    ) {
      fail('quote_binding_mismatch', 409);
    }
    let stored = this.#store.getPayment(binding.operation_id);
    let shouldReconcile = false;
    if (stored !== undefined) {
      if (
        stored.binding_digest !== digest ||
        canonicalJson(stored.binding) !== canonicalJson(binding)
      ) {
        fail('operation_id_conflict', 409);
      }
      if (
        stored.scheme !== payment.scheme ||
        canonicalJson(stored.payment) !== canonicalJson(payment)
      ) {
        fail('payment_authorization_conflict', 409);
      }
      if (stored.receipt !== undefined) return stored.receipt;
      if (stored.state === 'rejected') fail(stored.error ?? 'payment_rejected', 422);
      shouldReconcile = stored.state === 'settling' || stored.state === 'failed_retryable';
    } else {
      stored = {
        binding,
        binding_digest: digest,
        scheme: payment.scheme,
        payment,
        state: 'created',
        ...(payment.scheme === 'stake' ? { session_id: payment.session_id } : {}),
        updated_at: this.#now().toISOString(),
      };
      this.#store.putPayment(binding.operation_id, stored);
    }

    const input: SettlementInput = {
      vault:
        payment.scheme === 'stake' ? this.#sessionVault(payment.session_id) : binding.payer_wallet,
      operation_id: digest,
      policy_epoch: payment.scheme === 'stake' ? this.#sessionEpoch(payment.session_id) : 0n,
      amount: BigInt(binding.amount),
    };

    if (shouldReconcile) {
      const reconciled =
        payment.scheme === 'stake'
          ? await this.#sessionSettler.reconcile(input)
          : await this.#requireExact().reconcile(binding, payment.authorization);
      if (reconciled.settled && reconciled.tx_hash !== undefined) {
        return this.#recordReceipt(stored, reconciled.tx_hash);
      }
      if (reconciled.settled) fail('settlement_tx_not_found', 503);
    }

    if (payment.scheme === 'stake') await this.#validateStake(request, input);
    else this.#validateExact(request);

    stored.state = 'settling';
    delete stored.error;
    stored.updated_at = this.#now().toISOString();
    this.#store.putPayment(binding.operation_id, stored);

    const result =
      payment.scheme === 'stake'
        ? await this.#sessionSettler.settle(input)
        : await this.#requireExact().settle(binding, payment.authorization);
    if (result.status === 'settled') return this.#recordReceipt(stored, result.tx_hash);

    stored.state = result.status === 'uncertain' ? 'failed_retryable' : 'rejected';
    stored.error = result.reason;
    stored.updated_at = this.#now().toISOString();
    this.#store.putPayment(binding.operation_id, stored);
    fail(result.reason, result.status === 'uncertain' ? 503 : 422);
  }

  async #validateStake(request: SettleRequest, input: SettlementInput): Promise<void> {
    if (request.payment.scheme !== 'stake') return;
    const stored = this.#store.getSession(request.payment.session_id);
    if (stored === undefined) fail('session_not_found', 404);
    const session = stored.request.authorization;
    const binding = request.binding;
    const scope = request.payment.authorization;
    if (
      !same(session.payer_wallet, binding.payer_wallet) ||
      session.payer_subject !== binding.payer_subject ||
      !same(session.pay_to, binding.pay_to) ||
      !same(session.asset, binding.asset) ||
      session.network !== binding.network
    ) {
      fail('session_binding_mismatch', 422);
    }
    if (
      !same(session.workspace_hash, scope.workspace_hash) ||
      session.visibility !== scope.visibility ||
      !session.allowed_actions.includes(scope.action)
    ) {
      fail('session_scope_violation', 422);
    }
    const policy = await this.#policyReader.read(session.vault);
    this.#assertPolicy(
      session,
      policy,
      sessionScopeHash(session),
      BigInt(Math.floor(Date.parse(session.valid_until) / 1000)),
    );
    if (policy.revoked) fail('session_revoked', 422);
    const now = BigInt(Math.floor(this.#now().getTime() / 1000));
    if (policy.valid_until <= now) fail('session_expired', 422);
    if (input.amount > policy.per_operation_ceiling) fail('operation_ceiling_exceeded', 422);
    if (input.amount > policy.cap - policy.spent) fail('session_cap_exceeded', 422);
    if (input.amount > policy.funded_balance) fail('insufficient_funded_balance', 422);
  }

  #validateExact(request: SettleRequest): void {
    if (request.payment.scheme !== 'exact') return;
    const proof = request.payment.authorization.authorization;
    const binding = request.binding;
    if (
      !same(proof.from, binding.payer_wallet) ||
      !same(proof.to, binding.pay_to) ||
      proof.value !== binding.amount ||
      !same(proof.nonce, binding.nonce)
    ) {
      fail('exact_binding_mismatch', 422);
    }
  }

  #validateBinding(binding: OperationBinding): void {
    if (
      typeof binding !== 'object' ||
      binding === null ||
      typeof binding.operation_id !== 'string' ||
      typeof binding.payer_subject !== 'string' ||
      typeof binding.payer_wallet !== 'string' ||
      typeof binding.artifact_hash !== 'string' ||
      typeof binding.amount !== 'string' ||
      typeof binding.asset !== 'string' ||
      typeof binding.network !== 'string' ||
      typeof binding.pay_to !== 'string' ||
      typeof binding.expires_at !== 'string' ||
      typeof binding.nonce !== 'string'
    ) {
      fail('invalid_binding', 422);
    }
    if (binding.version !== 1) fail('unsupported_binding_version', 422);
    if (
      binding.operation_id.length === 0 ||
      binding.payer_subject.length === 0 ||
      binding.artifact_hash.length === 0
    ) {
      fail('incomplete_binding', 422);
    }
    if (
      !ADDRESS_RE.test(binding.payer_wallet) ||
      !ADDRESS_RE.test(binding.asset) ||
      !ADDRESS_RE.test(binding.pay_to)
    ) {
      fail('invalid_binding_address', 422);
    }
    if (!BYTES32_RE.test(binding.nonce)) fail('invalid_binding_nonce', 422);
    if (!UINT_RE.test(binding.amount) || BigInt(binding.amount) === 0n)
      fail('invalid_binding_amount', 422);
    if (binding.network !== this.#config.network) fail('network_mismatch', 422);
    if (!same(binding.asset, this.#config.asset)) fail('asset_mismatch', 422);
    if (!same(binding.pay_to, this.#config.payTo)) fail('payee_mismatch', 422);
    const expires = Date.parse(binding.expires_at);
    if (!Number.isFinite(expires) || expires <= this.#now().getTime()) fail('quote_expired', 422);
    if (expires > this.#now().getTime() + this.#config.quoteTtlSeconds * 1000) {
      fail('quote_expiry_too_long', 422);
    }
  }

  #validatePayment(request: SettleRequest): void {
    const payment = request.payment;
    if (
      typeof payment !== 'object' ||
      payment === null ||
      (payment.scheme !== 'stake' && payment.scheme !== 'exact') ||
      typeof payment.payer_wallet !== 'string'
    ) {
      fail('invalid_payment_authorization', 422);
    }
    if (payment.scheme === 'stake') {
      const scope = payment.authorization;
      if (
        typeof payment.session_id !== 'string' ||
        typeof scope !== 'object' ||
        scope === null ||
        typeof scope.workspace_hash !== 'string' ||
        typeof scope.visibility !== 'string' ||
        !['manual', 'pre_compaction', 'session_end'].includes(scope.action)
      ) {
        fail('invalid_session_payment_authorization', 422);
      }
      return;
    }
    const proof = payment.authorization;
    const authorization = proof?.authorization;
    if (
      typeof proof !== 'object' ||
      proof === null ||
      typeof proof.signature !== 'string' ||
      typeof authorization !== 'object' ||
      authorization === null ||
      typeof authorization.from !== 'string' ||
      typeof authorization.to !== 'string' ||
      typeof authorization.value !== 'string' ||
      typeof authorization.validAfter !== 'string' ||
      typeof authorization.validBefore !== 'string' ||
      typeof authorization.nonce !== 'string'
    ) {
      fail('invalid_exact_payment_authorization', 422);
    }
  }

  #assertPolicy(
    auth: RegisterSessionRequest['authorization'],
    policy: SessionPolicy,
    scopeHash: Hex,
    validUntil: bigint,
  ): void {
    if (
      !same(policy.facilitator, auth.facilitator) ||
      !same(policy.pay_to, auth.pay_to) ||
      policy.cap !== BigInt(auth.cap) ||
      policy.per_operation_ceiling !== BigInt(auth.per_operation_ceiling) ||
      policy.valid_until !== validUntil ||
      policy.epoch !== BigInt(auth.policy_epoch) ||
      !same(policy.scope_hash, scopeHash)
    ) {
      fail('onchain_policy_mismatch', 422);
    }
    if (policy.funded_balance < policy.cap - policy.spent) fail('session_not_fully_funded', 422);
  }

  #sessionView(
    request: RegisterSessionRequest,
    policy: SessionPolicy,
    createdAt: string,
  ): PaidSession {
    const auth = request.authorization;
    const now = BigInt(Math.floor(this.#now().getTime() / 1000));
    const status = policy.revoked ? 'revoked' : policy.valid_until <= now ? 'expired' : 'active';
    return {
      session_id: auth.session_id,
      status,
      authorization: auth,
      remaining: min(policy.cap - policy.spent, policy.funded_balance).toString(),
      funded_balance: policy.funded_balance.toString(),
      created_at: createdAt,
    };
  }

  #sessionVault(sessionId: string): Hex {
    const stored = this.#store.getSession(sessionId);
    if (stored === undefined) fail('session_not_found', 404);
    return stored.request.authorization.vault;
  }

  #sessionEpoch(sessionId: string): bigint {
    const stored = this.#store.getSession(sessionId);
    if (stored === undefined) fail('session_not_found', 404);
    return BigInt(stored.request.authorization.policy_epoch);
  }

  #requireExact(): ExactPaymentSettler {
    if (this.#exactSettler === undefined) fail('exact_payment_unavailable', 503);
    return this.#exactSettler;
  }

  #recordReceipt(stored: StoredPayment, txHash: Hex): PaymentReceipt {
    if (stored.receipt !== undefined) return stored.receipt;
    const settledAt = this.#now().toISOString();
    const payload = {
      version: 1 as const,
      service_id: this.#config.serviceId,
      operation_id: stored.binding.operation_id,
      scheme: stored.scheme,
      binding_digest: stored.binding_digest as Hex,
      payer_wallet: stored.binding.payer_wallet,
      amount: stored.binding.amount,
      asset: stored.binding.asset,
      network: stored.binding.network,
      pay_to: stored.binding.pay_to,
      settlement_tx: txHash,
      settled_at: settledAt,
    };
    const receipt: PaymentReceipt = {
      operation_id: stored.binding.operation_id,
      scheme: stored.scheme,
      status: 'settled',
      settlement_tx: txHash,
      settled_at: settledAt,
      receipt: this.#receiptSigner.sign(payload),
    };
    stored.state = 'settled';
    stored.receipt = receipt;
    delete stored.error;
    stored.updated_at = settledAt;
    this.#store.putPayment(stored.binding.operation_id, stored);
    return receipt;
  }
}
