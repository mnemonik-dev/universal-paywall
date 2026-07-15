import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson, operationDigest, sessionScopeHash } from '../canonical.js';
import { FilePaymentStore } from '../payment-store.js';
import { ReceiptSigner } from '../receipt.js';
import { sessionTypedData } from '../session-auth.js';
import { SessionPaymentService, type SessionPaymentServiceConfig } from '../session-service.js';
import type {
  ExactPaymentSettler,
  OperationBinding,
  RegisterSessionRequest,
  SessionAuthorization,
  SessionOperationSettler,
  SessionPolicy,
  SessionPolicyReader,
  SettleRequest,
} from '../session-types.js';
import type { Hex } from '../types.js';

const PAYER_KEY = `0x${'11'.repeat(32)}` as Hex;
const payer = privateKeyToAccount(PAYER_KEY);
const FACILITATOR = `0x${'22'.repeat(20)}` as Hex;
const PAY_TO = `0x${'33'.repeat(20)}` as Hex;
const ASSET = `0x${'44'.repeat(20)}` as Hex;
const VAULT = `0x${'55'.repeat(20)}` as Hex;
const FACTORY = `0x${'5f'.repeat(20)}` as Hex;
const WORKSPACE = `0x${'66'.repeat(32)}` as Hex;
const BINDING_WORKSPACE = '6666666666666666666666666666666666666666666666666666666666666666';
const NOW = new Date('2026-07-13T12:00:00.000Z');
const VALID_UNTIL = '2026-07-20T12:00:00.000Z';
const TX = `0x${'77'.repeat(32)}` as Hex;

const config: SessionPaymentServiceConfig = {
  serviceId: 'mnemonic',
  network: 'eip155:5042002',
  chainId: 5_042_002,
  asset: ASSET,
  facilitator: FACILITATOR,
  payTo: PAY_TO,
  quoteTtlSeconds: 600,
  factory: FACTORY,
  maxSessionSeconds: 7 * 24 * 60 * 60,
  enabledSchemes: ['exact', 'stake'],
};

function authorization(): SessionAuthorization {
  return {
    version: 1,
    service_id: 'mnemonic',
    session_id: 'session-1',
    payer_subject: 'subject-hash',
    payer_wallet: payer.address,
    vault: VAULT,
    facilitator: FACILITATOR,
    pay_to: PAY_TO,
    cap: '5000000',
    per_operation_ceiling: '50000',
    valid_until: VALID_UNTIL,
    network: config.network,
    asset: ASSET,
    policy_epoch: '1',
    workspace_hash: WORKSPACE,
    visibility: 'private',
    allowed_actions: ['manual', 'pre_compaction'],
    nonce: `0x${'88'.repeat(32)}`,
  };
}

async function registration(auth = authorization()): Promise<RegisterSessionRequest> {
  return {
    authorization: auth,
    signature: await payer.signTypedData(sessionTypedData(auth, config)),
  };
}

function policy(auth = authorization()): SessionPolicy {
  return {
    facilitator: FACILITATOR,
    pay_to: PAY_TO,
    cap: BigInt(auth.cap),
    spent: 0n,
    per_operation_ceiling: BigInt(auth.per_operation_ceiling),
    valid_until: BigInt(Math.floor(Date.parse(auth.valid_until) / 1000)),
    epoch: BigInt(auth.policy_epoch),
    scope_hash: sessionScopeHash(auth),
    revoked: false,
    funded_balance: BigInt(auth.cap),
  };
}

function binding(operationId = 'operation-1'): OperationBinding {
  return {
    version: 1,
    operation_id: operationId,
    payer_subject: 'subject-hash',
    payer_wallet: payer.address,
    artifact_hash: 'blake3:artifact',
    amount: '1000',
    asset: ASSET,
    network: config.network,
    pay_to: PAY_TO,
    expires_at: '2026-07-13T12:05:00.000Z',
    nonce: `0x${'55'.repeat(32)}`,
    scope: {
      workspace_hash: BINDING_WORKSPACE,
      visibility: 'private',
      action: 'manual',
    },
  };
}

function stakeRequest(operationId = 'operation-1'): SettleRequest {
  return {
    binding: binding(operationId),
    payment: {
      scheme: 'stake',
      session_id: 'session-1',
      payer_wallet: payer.address,
      authorization: {
        workspace_hash: WORKSPACE,
        visibility: 'private',
        action: 'manual',
      },
    },
  };
}

function exactRequest(operationId = 'exact-operation'): SettleRequest {
  const exactBinding = binding(operationId);
  return {
    binding: exactBinding,
    payment: {
      scheme: 'exact',
      payer_wallet: payer.address,
      authorization: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from: payer.address,
          to: PAY_TO,
          value: exactBinding.amount,
          validAfter: '0',
          validBefore: '9999999999',
          nonce: `0x${'99'.repeat(32)}` as Hex,
        },
      },
    },
  };
}

function harness(
  opts: {
    storePath?: string;
    uncertainOnce?: boolean;
    exactUncertainOnce?: boolean;
    exactAlreadySettled?: boolean;
    includeExact?: boolean;
    exactRejectReason?: string;
    trustedVault?: boolean;
    enabledSchemes?: Array<'exact' | 'stake'>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'up-session-test-'));
  const storePath = opts.storePath ?? join(dir, 'payments.json');
  const sessionPolicy = policy();
  const policyReader: SessionPolicyReader = { read: vi.fn(async () => sessionPolicy) };
  const vaultVerifier = {
    isTrustedVault: vi.fn(async () => opts.trustedVault ?? true),
  };
  const settled = new Map<Hex, Hex>();
  let uncertain = opts.uncertainOnce ?? false;
  let exactUncertain = opts.exactUncertainOnce ?? false;
  let exactSettled = opts.exactAlreadySettled ?? false;
  const sessionSettler: SessionOperationSettler = {
    reconcile: vi.fn(async (input) => {
      const tx = settled.get(input.operation_id);
      return tx === undefined ? { settled: false } : { settled: true, tx_hash: tx };
    }),
    settle: vi.fn(async (input) => {
      if (uncertain) {
        uncertain = false;
        settled.set(input.operation_id, TX);
        return { status: 'uncertain' as const, reason: 'rpc_timeout' };
      }
      settled.set(input.operation_id, TX);
      return { status: 'settled' as const, tx_hash: TX };
    }),
  };
  const exactSettler: ExactPaymentSettler = {
    reconcile: vi.fn(async () =>
      exactSettled ? { settled: true, tx_hash: TX } : { settled: false },
    ),
    settle: vi.fn(async () => {
      if (opts.exactRejectReason !== undefined) {
        return { status: 'failed' as const, reason: opts.exactRejectReason };
      }
      if (exactUncertain) {
        exactUncertain = false;
        exactSettled = true;
        return { status: 'uncertain' as const, reason: 'rpc_timeout' };
      }
      exactSettled = true;
      return { status: 'settled' as const, tx_hash: TX };
    }),
  };
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signer = new ReceiptSigner({ privateKeyPem, keyId: 'test-key-1' });
  const service = new SessionPaymentService({
    config: { ...config, ...(opts.enabledSchemes === undefined ? {} : { enabledSchemes: opts.enabledSchemes }) },
    store: new FilePaymentStore(storePath),
    policyReader,
    vaultVerifier,
    sessionSettler,
    ...(opts.includeExact ? { exactSettler } : {}),
    receiptSigner: signer,
    now: () => NOW,
  });
  return {
    service,
    sessionPolicy,
    sessionSettler,
    exactSettler,
    signer,
    privateKeyPem,
    storePath,
    vaultVerifier,
    policyReader,
  };
}

describe('SessionPaymentService', () => {
  it('defaults hosted quotes to one exact payment and rejects stake without its explicit gate', async () => {
    const { service } = harness({ includeExact: true, enabledSchemes: ['exact'] });
    const quote = await service.createQuote(binding('phase-1-exact'));
    expect(quote.accepts).toEqual([
      { scheme: 'exact', protocol: 'x402', authorization: 'eip3009' },
    ]);
    await expect(service.registerSession(await registration())).rejects.toThrow(
      'stake_payment_disabled',
    );
    await expect(service.settle(stakeRequest('phase-1-stake'))).rejects.toThrow(
      'stake_payment_disabled',
    );
  });

  it('validates a wallet-signed session against its funded on-chain policy', async () => {
    const { service } = harness();
    const session = await service.registerSession(await registration());
    expect(session.status).toBe('active');
    expect(session.remaining).toBe('5000000');
    await expect(service.registerSession(await registration())).resolves.toEqual(session);
  });

  it('rejects a wallet-signed policy for a vault outside the configured factory', async () => {
    const { service, policyReader } = harness({ trustedVault: false });
    await expect(service.registerSession(await registration())).rejects.toThrow(
      'untrusted_session_vault',
    );
    expect(policyReader.read).not.toHaveBeenCalled();
  });

  it('relays the same typed authorization when the on-chain policy is not installed yet', async () => {
    const base = harness();
    const expected = policy();
    const current = { ...expected, facilitator: `0x${'00'.repeat(20)}` as Hex, epoch: 0n };
    const registrar = {
      register: vi.fn(async () => {
        Object.assign(current, expected);
        return { tx_hash: TX };
      }),
    };
    const service = new SessionPaymentService({
      config,
      store: new FilePaymentStore(
        join(mkdtempSync(join(tmpdir(), 'up-register-test-')), 'store.json'),
      ),
      policyReader: { read: async () => current },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionRegistrar: registrar,
      sessionSettler: base.sessionSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem: base.privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    const session = await service.registerSession(await registration());
    expect(session.status).toBe('active');
    expect(registrar.register).toHaveBeenCalledTimes(1);
  });

  it('settles fifty concurrent retries once and returns one signed receipt', async () => {
    const { service, sessionSettler, signer } = harness();
    await service.registerSession(await registration());
    await service.createQuote(stakeRequest().binding);
    const receipts = await Promise.all(
      Array.from({ length: 50 }, () => service.settle(stakeRequest())),
    );
    expect(sessionSettler.settle).toHaveBeenCalledTimes(1);
    expect(new Set(receipts.map((receipt) => canonicalJson(receipt))).size).toBe(1);
    const signed = receipts[0]!.receipt;
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(signed.payload), 'utf8'),
        signer.publicKeyPem(),
        Buffer.from(signed.signature.value, 'base64url'),
      ),
    ).toBe(true);
  });

  it('rejects a conflicting request while the original operation is in flight', async () => {
    const { service } = harness();
    await service.registerSession(await registration());
    const original = stakeRequest();
    await service.createQuote(original.binding);
    const first = service.settle(original);
    const conflicting = stakeRequest();
    conflicting.binding.artifact_hash = 'different-artifact';
    await expect(service.settle(conflicting)).rejects.toThrow('operation_id_conflict');
    await expect(first).resolves.toMatchObject({ status: 'settled' });
  });

  it('reports a replaced on-chain policy as a superseded session', async () => {
    const { service, sessionPolicy } = harness();
    await service.registerSession(await registration());
    sessionPolicy.epoch = 2n;
    sessionPolicy.scope_hash = `0x${'aa'.repeat(32)}`;
    await expect(service.getSession('session-1')).resolves.toMatchObject({
      status: 'superseded',
    });
  });

  it('returns the durable receipt after a provider restart', async () => {
    const first = harness();
    await first.service.registerSession(await registration());
    await first.service.createQuote(stakeRequest().binding);
    const receipt = await first.service.settle(stakeRequest());

    const second = new SessionPaymentService({
      config,
      store: new FilePaymentStore(first.storePath),
      policyReader: { read: async () => first.sessionPolicy },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionSettler: first.sessionSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem: first.privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    await expect(second.settle(stakeRequest())).resolves.toEqual(receipt);
    expect(first.sessionSettler.settle).toHaveBeenCalledTimes(1);
  });

  it('reconciles an uncertain transaction instead of charging again', async () => {
    const { service, sessionSettler } = harness({ uncertainOnce: true });
    await service.registerSession(await registration());
    await service.createQuote(stakeRequest().binding);
    await expect(service.settle(stakeRequest())).rejects.toThrow('rpc_timeout');
    const status = await service.getPaymentStatus('operation-1');
    expect(status.status).toBe('settled');
    expect(status.receipt?.status).toBe('settled');
    expect(sessionSettler.settle).toHaveBeenCalledTimes(1);
  });

  it('rejects scope changes and operation-id binding reuse', async () => {
    const { service } = harness();
    await service.registerSession(await registration());
    const wrongScope = stakeRequest();
    await service.createQuote(wrongScope.binding);
    if (wrongScope.payment.scheme !== 'stake') throw new Error('expected stake');
    wrongScope.payment.authorization.workspace_hash = `0x${'aa'.repeat(32)}`;
    await expect(service.settle(wrongScope)).rejects.toThrow('session_scope_violation');

    await service.createQuote(stakeRequest('other-operation').binding);
    await service.settle(stakeRequest('other-operation'));
    const changed = stakeRequest('other-operation');
    changed.binding.artifact_hash = 'different';
    await expect(service.settle(changed)).rejects.toThrow('quote_binding_mismatch');
  });

  it('uses the same binding and receipt shape for one-time exact x402', async () => {
    const { service, exactSettler, signer } = harness({ includeExact: true });
    const request = exactRequest();
    await service.createQuote(request.binding);
    const receipt = await service.settle(request);
    expect(receipt.scheme).toBe('exact');
    expect(receipt.receipt.payload.binding_digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(receipt.receipt.payload), 'utf8'),
        signer.publicKeyPem(),
        Buffer.from(receipt.receipt.signature.value, 'base64url'),
      ),
    ).toBe(true);
    expect(exactSettler.settle).toHaveBeenCalledTimes(1);
  });

  it('settles fifty concurrent exact retries once and returns one receipt', async () => {
    const { service, exactSettler } = harness({ includeExact: true, enabledSchemes: ['exact'] });
    const request = exactRequest('exact-concurrent');
    await service.createQuote(request.binding);
    const receipts = await Promise.all(Array.from({ length: 50 }, () => service.settle(request)));
    expect(exactSettler.settle).toHaveBeenCalledTimes(1);
    expect(new Set(receipts.map((receipt) => canonicalJson(receipt))).size).toBe(1);
  });

  it('rejects an expired quote binding before accepting a payment proof', async () => {
    const { service, exactSettler } = harness({ includeExact: true, enabledSchemes: ['exact'] });
    const request = exactRequest('expired-exact');
    request.binding.expires_at = '2026-07-13T11:59:59.000Z';
    await expect(service.createQuote(request.binding)).rejects.toThrow('quote_expired');
    expect(exactSettler.settle).not.toHaveBeenCalled();
  });

  it('records an insufficient-USDC wallet rejection once without creating a receipt', async () => {
    const { service, exactSettler, storePath, sessionPolicy, sessionSettler, privateKeyPem } = harness({
      includeExact: true,
      enabledSchemes: ['exact'],
      exactRejectReason: 'insufficient_usdc',
    });
    const request = exactRequest('insufficient-usdc');
    await service.createQuote(request.binding);
    await expect(service.settle(request)).rejects.toThrow('insufficient_usdc');
    await expect(service.settle(request)).rejects.toThrow('insufficient_usdc');
    expect(exactSettler.settle).toHaveBeenCalledTimes(1);
    await expect(service.getPaymentStatus(request.binding.operation_id)).resolves.toMatchObject({
      status: 'rejected',
      error: 'insufficient_usdc',
    });
    const afterRestart = new SessionPaymentService({
      config: { ...config, enabledSchemes: ['exact'] },
      store: new FilePaymentStore(storePath),
      policyReader: { read: async () => sessionPolicy },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionSettler,
      exactSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    await expect(afterRestart.settle(request)).rejects.toThrow('insufficient_usdc');
    expect(exactSettler.settle).toHaveBeenCalledTimes(1);
  });

  it('refuses replay proofs when any quote-bound exact-payment field changes', async () => {
    const mutations: Array<[string, (request: SettleRequest) => void]> = [
      ['artifact', (request) => { request.binding.artifact_hash = 'blake3:altered'; }],
      ['subject', (request) => { request.binding.payer_subject = 'other-subject'; }],
      ['wallet', (request) => { request.binding.payer_wallet = `0x${'aa'.repeat(20)}` as Hex; }],
      ['amount', (request) => { request.binding.amount = '1001'; }],
      ['payee', (request) => { request.binding.pay_to = `0x${'bb'.repeat(20)}` as Hex; }],
      ['network', (request) => { request.binding.network = 'eip155:1'; }],
      ['nonce', (request) => { request.binding.nonce = `0x${'cc'.repeat(32)}` as Hex; }],
      ['expiry', (request) => { request.binding.expires_at = '2026-07-13T12:04:00.000Z'; }],
    ];
    for (const [field, mutate] of mutations) {
      const { service, exactSettler } = harness({ includeExact: true, enabledSchemes: ['exact'] });
      const original = exactRequest(`replay-${field}`);
      await service.createQuote(original.binding);
      const replay = structuredClone(original);
      mutate(replay);
      await expect(service.settle(replay)).rejects.toThrow();
      expect(exactSettler.settle).not.toHaveBeenCalled();
    }
  });

  it('returns an exact receipt after provider restart without resettling', async () => {
    const first = harness({ includeExact: true, enabledSchemes: ['exact'] });
    const request = exactRequest('exact-restart');
    await first.service.createQuote(request.binding);
    const receipt = await first.service.settle(request);
    const second = new SessionPaymentService({
      config: { ...config, enabledSchemes: ['exact'] },
      store: new FilePaymentStore(first.storePath),
      policyReader: { read: async () => first.sessionPolicy },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionSettler: first.sessionSettler,
      exactSettler: first.exactSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem: first.privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    await expect(second.settle(request)).resolves.toEqual(receipt);
    expect(first.exactSettler.settle).toHaveBeenCalledTimes(1);
  });

  it('handles created and settling exact records safely after a provider restart', async () => {
    const created = harness({ includeExact: true, enabledSchemes: ['exact'] });
    const createdRequest = exactRequest('exact-created-restart');
    const createdQuote = await created.service.createQuote(createdRequest.binding);
    new FilePaymentStore(created.storePath).putPayment(createdRequest.binding.operation_id, {
      binding: createdRequest.binding,
      binding_digest: createdQuote.binding_digest,
      scheme: 'exact',
      payment: createdRequest.payment,
      state: 'created',
      updated_at: NOW.toISOString(),
    });
    const afterCreatedRestart = new SessionPaymentService({
      config: { ...config, enabledSchemes: ['exact'] },
      store: new FilePaymentStore(created.storePath),
      policyReader: { read: async () => created.sessionPolicy },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionSettler: created.sessionSettler,
      exactSettler: created.exactSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem: created.privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    await expect(afterCreatedRestart.settle(createdRequest)).resolves.toMatchObject({ status: 'settled' });
    expect(created.exactSettler.settle).toHaveBeenCalledTimes(1);

    const settling = harness({
      includeExact: true,
      enabledSchemes: ['exact'],
      exactAlreadySettled: true,
    });
    const settlingRequest = exactRequest('exact-settling-restart');
    const settlingQuote = await settling.service.createQuote(settlingRequest.binding);
    new FilePaymentStore(settling.storePath).putPayment(settlingRequest.binding.operation_id, {
      binding: settlingRequest.binding,
      binding_digest: settlingQuote.binding_digest,
      scheme: 'exact',
      payment: settlingRequest.payment,
      state: 'settling',
      updated_at: NOW.toISOString(),
    });
    const afterSettlingRestart = new SessionPaymentService({
      config: { ...config, enabledSchemes: ['exact'] },
      store: new FilePaymentStore(settling.storePath),
      policyReader: { read: async () => settling.sessionPolicy },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionSettler: settling.sessionSettler,
      exactSettler: settling.exactSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem: settling.privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    await expect(afterSettlingRestart.settle(settlingRequest)).resolves.toMatchObject({
      status: 'settled',
      binding_digest: operationDigest(settlingRequest.binding),
    });
    expect(settling.exactSettler.reconcile).toHaveBeenCalledTimes(1);
    expect(settling.exactSettler.settle).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain exact settlement after provider restart without a second charge', async () => {
    const first = harness({
      includeExact: true,
      enabledSchemes: ['exact'],
      exactUncertainOnce: true,
    });
    const request = exactRequest('exact-uncertain-restart');
    await first.service.createQuote(request.binding);
    await expect(first.service.settle(request)).rejects.toThrow('rpc_timeout');

    const second = new SessionPaymentService({
      config: { ...config, enabledSchemes: ['exact'] },
      store: new FilePaymentStore(first.storePath),
      policyReader: { read: async () => first.sessionPolicy },
      vaultVerifier: { isTrustedVault: async () => true },
      sessionSettler: first.sessionSettler,
      exactSettler: first.exactSettler,
      receiptSigner: new ReceiptSigner({ privateKeyPem: first.privateKeyPem, keyId: 'test-key-1' }),
      now: () => NOW,
    });
    await expect(second.getPaymentStatus(request.binding.operation_id)).resolves.toMatchObject({
      status: 'settled',
      receipt: { scheme: 'exact', settlement_tx: TX },
    });
    expect(first.exactSettler.settle).toHaveBeenCalledTimes(1);
    expect(first.exactSettler.reconcile).toHaveBeenCalledTimes(1);
  });
});
