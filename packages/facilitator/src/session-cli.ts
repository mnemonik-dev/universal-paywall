import { readFileSync } from 'node:fs';
import { FilePaymentStore } from './payment-store.js';
import { ReceiptSigner } from './receipt.js';
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

function main(): void {
  const rpcUrl = env('ARC_RPC_URL');
  const chainId = Number(env('CHAIN_ID'));
  const facilitatorKey = env('FACILITATOR_KEY') as Hex;
  const facilitatorAddress = privateKeyToAccount(facilitatorKey).address;
  const asset = env('USDC_ADDRESS') as Hex;
  const factory = env('SESSION_STAKE_VAULT_FACTORY') as Hex;
  const fromBlock = BigInt(process.env['SESSION_RAIL_FROM_BLOCK'] ?? '0');
  const chain = new OnChainSessionPayments({
    rpcUrl,
    chainId,
    facilitatorKey,
    asset,
    factory,
    fromBlock,
  });
  const exactEnabled = process.env['EXACT_PAYMENTS_ENABLED'] === '1';
  const exact = exactEnabled
    ? new OnChainExactPayments({
        rpcUrl,
        chainId,
        facilitatorKey,
        asset,
        eip712Name: env('USDC_EIP712_NAME'),
        eip712Version: env('USDC_EIP712_VERSION'),
        fromBlock,
      })
    : undefined;
  const signer = new ReceiptSigner({
    privateKeyPem: readFileSync(env('RECEIPT_PRIVATE_KEY_FILE'), 'utf8'),
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
      quoteTtlSeconds: Number(process.env['QUOTE_TTL_SECONDS'] ?? '300'),
      factory,
      maxSessionSeconds: Number(process.env['MAX_SESSION_SECONDS'] ?? '604800'),
    },
    store: new FilePaymentStore(env('PAYMENT_STORE_PATH')),
    policyReader: chain,
    vaultVerifier: chain,
    sessionRegistrar: chain,
    sessionSettler: chain,
    ...(exact === undefined ? {} : { exactSettler: exact }),
    receiptSigner: signer,
  });
  const server = createSessionPaymentServer(service, {
    apiKeys: env('SERVICE_API_KEYS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const port = Number(process.env['PORT'] ?? '8403');
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`up-session-facilitator listening on :${port}`);
  });
}

main();
