import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpaqueRelayerKey } from './eip3009/index.js';
import { FilePaymentStore } from './payment-store.js';
import { ReceiptSigner } from './receipt.js';
import { X402Facilitator } from './x402-http.js';
import { OnChainExactPayments, OnChainSessionPayments } from './session-chain.js';
import { createSessionPaymentServer } from './session-server.js';
import { SessionPaymentService } from './session-service.js';
import type { Hex } from './types.js';
import { privateKeyToAccount } from 'viem/accounts';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`missing env: ${name}`);
  return value;
}

function parsePositiveInt(value: string, name: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid env: ${name} must be a positive integer`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`invalid env: ${name} must be <= ${max}`);
  }
  return parsed;
}

function parseNonNegativeBigInt(value: string, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error(`invalid env: ${name} must be non-negative`);
    return parsed;
  } catch {
    throw new Error(`invalid env: ${name} must be a non-negative integer`);
  }
}

function readRestrictedFile(path: string, name: string): string {
  const resolved = resolve(path);
  const stats = statSync(resolved);
  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`invalid permissions: ${name} must be readable only by owner (0o600)`);
  }
  return readFileSync(resolved, 'utf8');
}

function main(): void {
  const rpcUrl = env('ARC_RPC_URL');
  const chainId = parsePositiveInt(env('CHAIN_ID'), 'CHAIN_ID');
  const facilitatorKey = env('FACILITATOR_KEY') as Hex;
  const facilitatorAddress = privateKeyToAccount(facilitatorKey).address;
  const asset = env('USDC_ADDRESS') as Hex;
  const factory = env('SESSION_STAKE_VAULT_FACTORY') as Hex;
  const fromBlock = parseNonNegativeBigInt(
    process.env['SESSION_RAIL_FROM_BLOCK'] ?? '0',
    'SESSION_RAIL_FROM_BLOCK',
  );
  const chain = new OnChainSessionPayments({
    rpcUrl,
    chainId,
    facilitatorKey,
    asset,
    factory,
    fromBlock,
  });
  if (process.env['EXACT_PAYMENTS_ENABLED'] !== '1') {
    throw new Error(
      'invalid env: EXACT_PAYMENTS_ENABLED=1 is required for the Phase 1 exact-only rail',
    );
  }
  const exact = new OnChainExactPayments({
    rpcUrl,
    chainId,
    facilitatorKey,
    asset,
    eip712Name: env('USDC_EIP712_NAME'),
    eip712Version: env('USDC_EIP712_VERSION'),
    fromBlock,
  });
  const signer = new ReceiptSigner({
    privateKeyPem: readRestrictedFile(env('RECEIPT_PRIVATE_KEY_FILE'), 'RECEIPT_PRIVATE_KEY_FILE'),
    keyId: env('RECEIPT_KEY_ID'),
  });
  const service = new SessionPaymentService({
    config: {
      serviceId: env('SERVICE_ID'),
      network: env('NETWORK'),
      chainId,
      asset,
      facilitator: facilitatorAddress,
      payTo: env('SERVICE_PAY_TO') as Hex,
      quoteTtlSeconds: parsePositiveInt(
        process.env['QUOTE_TTL_SECONDS'] ?? '300',
        'QUOTE_TTL_SECONDS',
        86_400,
      ),
      factory,
      maxSessionSeconds: parsePositiveInt(
        process.env['MAX_SESSION_SECONDS'] ?? '604800',
        'MAX_SESSION_SECONDS',
        31_536_000,
      ),
      // Phase 1 is deliberately exact-only. Stake must not become available
      // merely because its vault environment is configured.
      enabledSchemes: ['exact'],
    },
    store: new FilePaymentStore(env('PAYMENT_STORE_PATH')),
    policyReader: chain,
    vaultVerifier: chain,
    sessionRegistrar: chain,
    sessionSettler: chain,
    exactSettler: exact,
    receiptSigner: signer,
  });
  const apiKeys = env('SERVICE_API_KEYS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (apiKeys.length === 0)
    throw new Error('invalid env: SERVICE_API_KEYS must contain at least one key');
  // x402 v1 facilitator API (U1): the deployment's single network as an
  // explicit row — env-configured, independent of the NETWORKS registry.
  // The zero addresses are the factory/vault fields verify/settle never read.
  const networkLabel = env('NETWORK');
  if (/^eip155:\d+$/.test(networkLabel) && networkLabel !== `eip155:${chainId}`) {
    throw new Error(
      `invalid env: NETWORK ${networkLabel} names a different chain than CHAIN_ID ${chainId}`,
    );
  }
  const zeroAddress = `0x${'0'.repeat(40)}` as Hex;
  const x402 = new X402Facilitator({
    network: {
      id: `eip155:${chainId}`,
      alias: networkLabel,
      chainId,
      rpcUrl,
      usdcAddress: asset,
      usdcEip712Name: env('USDC_EIP712_NAME'),
      usdcEip712Version: env('USDC_EIP712_VERSION'),
      factoryAddress: zeroAddress,
      vaultImplAddress: zeroAddress,
      enabled: true,
    },
    relayerKey: new OpaqueRelayerKey(facilitatorKey),
    relayerAddress: facilitatorAddress,
    log: (event, fields) => {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ event, ...fields }));
    },
  });
  const server = createSessionPaymentServer(service, { apiKeys, x402 });
  const port = parsePositiveInt(process.env['PORT'] ?? '8403', 'PORT', 65_535);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`up-session-facilitator listening on :${port}`);
  });
}

main();
