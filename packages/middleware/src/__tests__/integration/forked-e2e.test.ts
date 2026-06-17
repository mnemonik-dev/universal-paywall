/**
 * Forked integration suite — runs in CI by default (no env gate).
 *
 * Spawns a real `anvil` child process in `beforeAll`, deploys
 * `MockUsdcEip3009`, `PaymentVaultImpl`, and `PaymentSplitterFactory`
 * programmatically via viem (reading bytecode + ABI from Foundry's
 * `contracts/out/<Contract>.sol/<Contract>.json`), spins up BOTH a Node
 * `http` server (wrapped via `withPaywall`) and a Fastify app (wrapped via
 * `fastifyPaywall`) in the same process, and exercises the full x402
 * pipeline through both adapters.
 *
 * Key invariants pinned here:
 *   - happy path through Node http adapter (402 → sign → 200 + vault delta).
 *   - happy path through Fastify adapter (same).
 *   - cross-adapter `NonceStore` replay-rejection (D5 process-singleton): pay
 *     via Node http, retry the IDENTICAL `X-PAYMENT` on Fastify → 402
 *     `nonce_already_used`. Proves both adapters share the module-scope
 *     NonceStore.
 *   - `vault_not_deployed` rejection.
 *   - `paused` rejection (after waiting for the factory-state cache TTL).
 *
 * Environment:
 *   - `TEST_PORT` (default `8545`) controls the spawned anvil port so CI
 *     parallel shards can pick non-colliding ports.
 *
 * Pre-flight:
 *   - `anvil` (Foundry) on PATH (installed by Task 2).
 *   - `cd contracts && forge build` has run, producing
 *     `contracts/out/<Contract>.sol/<Contract>.json` artifacts.
 *   - `npm run build --workspace=@universal-paywall/middleware` — the test
 *     imports the workspace package `@universal-paywall/middleware` which
 *     resolves through `exports` to `dist/index.js`.
 *
 * Vitest runner — NO Mocha-isms. Timeouts come from `vitest.config.ts`
 * (`testTimeout: 60_000`, `hookTimeout: 30_000`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http, { type Server as HttpServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  parseAbi,
  toHex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import Fastify, { type FastifyInstance } from 'fastify';

import { fastifyPaywall, OpaqueRelayerKey, withPaywall } from '@universal-paywall/middleware';
import type { PaywallConfig } from '@universal-paywall/middleware';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_PORT = Number(process.env['TEST_PORT'] ?? 8545);
const RPC_URL = `http://127.0.0.1:${TEST_PORT}`;
const CHAIN_ID = 31337;

// Anvil's default mnemonic ("test test test … junk") deterministically derives
// these accounts. Indexes used by this suite:
//   0 — deployer (also owner of MockUsdc + factory)
//   1 — developer A (registers a vault)
//   2 — payer (signs EIP-3009 authorizations; mints itself USDC)
//   3 — relayer (broadcasts settle txs; pre-funded with mock USDC for the
//                D17 / iter-3 §7 balance pre-check)
//   4 — platformTreasury (passive — receives fee on settle)
//   5 — developer B (never registers — used to test vault_not_deployed)
const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
] as const satisfies readonly `0x${string}`[];

// Generous EIP-3009 validBefore window so the verify.ts 5 s safety margin
// never trips even on slow CI.
const VALID_BEFORE = () => BigInt(Math.floor(Date.now() / 1000) + 600);

// USDC has 6 decimals — base unit. `parseUsdPrice('0.01')` = 10000n.
const PRICE_USD = '0.01';
const PRICE_BASE_UNITS = 10_000n;

const NETWORK_ID = `eip155:${CHAIN_ID}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/middleware/src/__tests__/integration → repo root → contracts/out
const CONTRACTS_OUT = path.resolve(__dirname, '..', '..', '..', '..', '..', 'contracts', 'out');

interface Artifact {
  abi: readonly unknown[];
  bytecode: { object: `0x${string}` };
}

function readArtifact(contractName: string): Artifact {
  const file = path.join(CONTRACTS_OUT, `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Foundry artifact missing: ${file}. Run \`cd contracts && forge build\` first.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Artifact;
  return parsed;
}

async function waitForPort(port: number, opts: { timeout: number; host?: string }): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const deadline = Date.now() + opts.timeout;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(v);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForPort: ${host}:${port} did not become ready within ${opts.timeout}ms`);
}

function listenEphemeral(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('http server.address() returned no port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function randomNonceHex(): `0x${string}` {
  return toHex(crypto.randomBytes(32)) as `0x${string}`;
}

interface SignAuthArgs {
  payerPk: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  nonce: `0x${string}`;
  usdcAddress: `0x${string}`;
  usdcName: string;
  usdcVersion: string;
  chainId: number;
}

interface SignedPayload {
  signature: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
}

async function signEip3009Authorization(args: SignAuthArgs): Promise<SignedPayload> {
  const account = privateKeyToAccount(args.payerPk);
  const validAfter = 0n;
  const validBefore = VALID_BEFORE();
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;
  const signature = await account.signTypedData({
    domain: {
      name: args.usdcName,
      version: args.usdcVersion,
      chainId: args.chainId,
      verifyingContract: args.usdcAddress,
    },
    types,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: args.to,
      value: args.value,
      validAfter,
      validBefore,
      nonce: args.nonce,
    },
  });
  return {
    signature,
    authorization: {
      from: account.address,
      to: args.to,
      value: args.value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: args.nonce,
    },
  };
}

function encodeXPaymentHeader(payload: SignedPayload, network: string): string {
  const wire = {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload,
  };
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64');
}

interface FetchResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function httpGet(origin: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        method: 'GET',
        path: url.pathname,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown = raw;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
          }
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(',');
            else if (typeof v === 'string') flat[k.toLowerCase()] = v;
          }
          resolve({ status: res.statusCode ?? 0, body, headers: flat });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Suite-level state ───────────────────────────────────────────────────────

interface SuiteState {
  anvil: ChildProcess;
  publicClient: PublicClient;
  walletDeployer: WalletClient;
  walletDeveloperA: WalletClient;
  walletDeveloperB: WalletClient;
  walletOwner: WalletClient;
  usdcAddress: `0x${string}`;
  factoryAddress: `0x${string}`;
  vaultImplAddress: `0x${string}`;
  developerAVault: `0x${string}`;
  nodeServerA: HttpServer; // developer A
  nodeServerAOrigin: string;
  fastifyServerA: FastifyInstance;
  fastifyServerAOrigin: string;
  nodeServerB: HttpServer; // developer B (unregistered → vault_not_deployed)
  nodeServerBOrigin: string;
  nodeServerPaused: HttpServer;
  nodeServerPausedOrigin: string;
}

let state: SuiteState | undefined;

async function killAnvil(child: ChildProcess): Promise<void> {
  if (child.killed) return;
  child.kill('SIGTERM');
  // Escalate to SIGKILL after 2 s if anvil is still up.
  const stopped = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 2_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!stopped && !child.killed) child.kill('SIGKILL');
}

function buildConfig(developerEoa: `0x${string}`): PaywallConfig {
  return {
    price: PRICE_USD,
    developerEoa,
    network: NETWORK_ID,
    facilitator: {
      mode: 'inline',
      // Use anvil account 3 (relayer) — funded with mock USDC during setup
      // so the iter-3 §7 relayer-balance pre-check passes.
      relayerKey: new OpaqueRelayerKey(ANVIL_KEYS[3]),
      rpcUrl: RPC_URL,
    },
  };
}

// Side-stage a copy of NETWORKS keyed on our anvil chainId so the middleware
// can resolve `network = 'eip155:31337'`. The middleware's `paywall(req,
// opts)` reads `NETWORKS[opts.network]` — so we mutate the registry in place.
// (This is test-only: vitest's process is isolated from production code, and
// the suite tears the mutation down in `afterAll`.)
async function patchNetworksForAnvil(args: {
  factoryAddress: `0x${string}`;
  vaultImplAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
}): Promise<() => void> {
  // Late dynamic import so the module-scope mutation is reachable from the
  // same module instance the middleware sees (workspace package resolution
  // caches the module).
  const networksModule = (await import('@universal-paywall/middleware')) as {
    NETWORKS: Record<string, unknown>;
  };
  const NETWORKS = networksModule.NETWORKS as Record<string, unknown>;
  const row = {
    id: NETWORK_ID,
    alias: 'anvil-forked',
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    usdcAddress: args.usdcAddress,
    usdcEip712Name: 'USD Coin',
    usdcEip712Version: '2',
    factoryAddress: args.factoryAddress,
    vaultImplAddress: args.vaultImplAddress,
    enabled: true,
  };
  const target = NETWORKS as Record<string, unknown>;
  const prev = target[NETWORK_ID];
  // Writeable single source of truth — both keys ('anvil-forked' and CAIP-2
  // form) point at the same object for parity with the arc-testnet row.
  Object.defineProperty(target, NETWORK_ID, {
    value: row,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  Object.defineProperty(target, 'anvil-forked', {
    value: row,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  return () => {
    if (prev === undefined) {
      delete target[NETWORK_ID];
    } else {
      Object.defineProperty(target, NETWORK_ID, {
        value: prev,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    }
    delete target['anvil-forked'];
  };
}

let restoreNetworks: (() => void) | undefined;

// ─── beforeAll: spawn anvil, deploy contracts, wire servers ──────────────────

describe('forked e2e', () => {
  beforeAll(async () => {
    // Step 1: spawn anvil.
    const anvilStderr: string[] = [];
    const anvil = spawn('anvil', ['--chain-id', String(CHAIN_ID), '--port', String(TEST_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    anvil.stderr?.on('data', (c: Buffer) => {
      anvilStderr.push(c.toString());
    });
    try {
      await waitForPort(TEST_PORT, { timeout: 30_000 });
    } catch (err) {
      if (anvilStderr.length > 0) {
        // eslint-disable-next-line no-console
        console.error('[forked-e2e] anvil stderr:\n' + anvilStderr.join(''));
      }
      await killAnvil(anvil);
      throw err;
    }

    // Step 2: viem clients.
    const transport = viemHttp(RPC_URL);
    const publicClient = createPublicClient({ transport }) as PublicClient;
    const walletDeployer = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS[0]),
      transport,
    });
    const walletDeveloperA = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS[1]),
      transport,
    });
    const walletDeveloperB = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS[5]),
      transport,
    });
    const walletOwner = walletDeployer; // factory.owner() defaults to msg.sender

    // Step 3: deploy MockUsdcEip3009 (no ctor args).
    const usdcArt = readArtifact('MockUsdcEip3009');
    const usdcDeployHash = await walletDeployer.deployContract({
      account: walletDeployer.account!,
      chain: null,
      abi: usdcArt.abi as never,
      bytecode: usdcArt.bytecode.object,
      args: [],
    });
    const usdcRcpt = await publicClient.waitForTransactionReceipt({
      hash: usdcDeployHash,
    });
    const usdcAddress = usdcRcpt.contractAddress!;

    // Step 4: deploy PaymentSplitterFactory (3-arg canonical ctor).
    const factoryArt = readArtifact('PaymentSplitterFactory');
    const platformTreasury = privateKeyToAccount(ANVIL_KEYS[4]).address;
    const factoryDeployHash = await walletDeployer.deployContract({
      account: walletDeployer.account!,
      chain: null,
      abi: factoryArt.abi as never,
      bytecode: factoryArt.bytecode.object,
      args: [usdcAddress, platformTreasury, 50],
    });
    const factoryRcpt = await publicClient.waitForTransactionReceipt({
      hash: factoryDeployHash,
    });
    const factoryAddress = factoryRcpt.contractAddress!;

    // Step 5: read the factory's vaultImpl (deployed inside the ctor).
    const vaultImplAddress = (await publicClient.readContract({
      address: factoryAddress,
      abi: parseAbi(['function vaultImpl() view returns (address)']),
      functionName: 'vaultImpl',
    })) as `0x${string}`;

    // Step 6: developer A calls factory.register() to deploy their vault clone.
    const registerHash = await walletDeveloperA.writeContract({
      account: walletDeveloperA.account!,
      chain: null,
      address: factoryAddress,
      abi: parseAbi(['function register()']),
      functionName: 'register',
      args: [],
    });
    await publicClient.waitForTransactionReceipt({ hash: registerHash });

    const developerAVault = (await publicClient.readContract({
      address: factoryAddress,
      abi: parseAbi(['function vaults(address) view returns (address)']),
      functionName: 'vaults',
      args: [walletDeveloperA.account!.address],
    })) as `0x${string}`;
    expect(developerAVault).not.toBe('0x0000000000000000000000000000000000000000');

    // Step 7: mint USDC to the payer (account 2) and pre-fund the relayer
    //         (account 3) with USDC so the iter-3 §7 relayer-balance pre-check
    //         passes. The mock token has no native-gas semantics; anvil
    //         pre-funds every account with 10000 ETH.
    const payerAddress = privateKeyToAccount(ANVIL_KEYS[2]).address;
    const relayerAddress = privateKeyToAccount(ANVIL_KEYS[3]).address;
    const mintAbi = parseAbi(['function mint(address,uint256)']);
    const mintPayerHash = await walletDeployer.writeContract({
      account: walletDeployer.account!,
      chain: null,
      address: usdcAddress,
      abi: mintAbi,
      functionName: 'mint',
      args: [payerAddress, 10_000_000n], // 10 USDC
    });
    await publicClient.waitForTransactionReceipt({ hash: mintPayerHash });
    const mintRelayerHash = await walletDeployer.writeContract({
      account: walletDeployer.account!,
      chain: null,
      address: usdcAddress,
      abi: mintAbi,
      functionName: 'mint',
      args: [relayerAddress, 10_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintRelayerHash });

    // Step 8: patch NETWORKS in place so opts.network = 'eip155:31337'.
    restoreNetworks = await patchNetworksForAnvil({
      factoryAddress,
      vaultImplAddress,
      usdcAddress,
    });

    // Step 9: spin up node http + fastify servers for developer A.
    const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
    };

    const configA = buildConfig(walletDeveloperA.account!.address);
    const nodeServerA = http.createServer(withPaywall(handler, configA));
    const nodeServerAPort = await listenEphemeral(nodeServerA);
    const nodeServerAOrigin = `http://127.0.0.1:${nodeServerAPort}/resource`;

    const fastifyServerA = Fastify({ logger: false });
    await fastifyServerA.register(fastifyPaywall(configA));
    fastifyServerA.get('/resource', async (_request, reply) => {
      reply.code(200).type('text/plain').send('ok');
    });
    await fastifyServerA.listen({ port: 0, host: '127.0.0.1' });
    const fastifyAddr = fastifyServerA.server.address();
    if (fastifyAddr === null || typeof fastifyAddr === 'string') {
      throw new Error('fastify server.address() returned no port');
    }
    const fastifyServerAOrigin = `http://127.0.0.1:${fastifyAddr.port}/resource`;

    // Step 10: Node server for developer B (unregistered → vault_not_deployed).
    const configB = buildConfig(walletDeveloperB.account!.address);
    const nodeServerB = http.createServer(withPaywall(handler, configB));
    const nodeServerBPort = await listenEphemeral(nodeServerB);
    const nodeServerBOrigin = `http://127.0.0.1:${nodeServerBPort}/resource`;

    // Step 11: Node server for the paused branch (paused asserted at test time
    //          by pausing the factory; the same config A is used and the test
    //          calls factory.pause()).
    const nodeServerPaused = http.createServer(withPaywall(handler, configA));
    const nodeServerPausedPort = await listenEphemeral(nodeServerPaused);
    const nodeServerPausedOrigin = `http://127.0.0.1:${nodeServerPausedPort}/resource`;

    state = {
      anvil,
      publicClient,
      walletDeployer,
      walletDeveloperA,
      walletDeveloperB,
      walletOwner,
      usdcAddress,
      factoryAddress,
      vaultImplAddress,
      developerAVault,
      nodeServerA,
      nodeServerAOrigin,
      fastifyServerA,
      fastifyServerAOrigin,
      nodeServerB,
      nodeServerBOrigin,
      nodeServerPaused,
      nodeServerPausedOrigin,
    };
  });

  afterAll(async () => {
    if (state !== undefined) {
      await new Promise<void>((resolve) => state!.nodeServerA.close(() => resolve()));
      await new Promise<void>((resolve) => state!.nodeServerB.close(() => resolve()));
      await new Promise<void>((resolve) => state!.nodeServerPaused.close(() => resolve()));
      try {
        await state.fastifyServerA.close();
      } catch {
        /* swallow */
      }
      await killAnvil(state.anvil);
    }
    if (restoreNetworks !== undefined) {
      restoreNetworks();
      restoreNetworks = undefined;
    }
    state = undefined;
  });

  // ─── Tests ─────────────────────────────────────────────────────────────────

  it('node-http happy path: 402 → sign → 200; vault balance grows; authorizationState true', async () => {
    if (state === undefined) throw new Error('state not initialized');
    const { publicClient, usdcAddress, developerAVault, nodeServerAOrigin } = state;

    // First GET — no X-PAYMENT → 402 with challenge body.
    const r402 = await httpGet(nodeServerAOrigin);
    expect(r402.status).toBe(402);
    const body402 = r402.body as Record<string, unknown>;
    expect(body402['x402Version']).toBe(1);
    expect(body402['error']).toBe('payment_required');
    const accepts = body402['accepts'] as Array<Record<string, unknown>>;
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.['payTo']).toBe(developerAVault);
    expect(accepts[0]?.['maxAmountRequired']).toBe(PRICE_BASE_UNITS.toString());

    // Sign EIP-3009 authorization → second GET → 200 with X-PAYMENT-RESPONSE.
    const nonce = randomNonceHex();
    const signed = await signEip3009Authorization({
      payerPk: ANVIL_KEYS[2],
      to: developerAVault,
      value: PRICE_BASE_UNITS,
      nonce,
      usdcAddress,
      usdcName: 'USD Coin',
      usdcVersion: '2',
      chainId: CHAIN_ID,
    });
    const header = encodeXPaymentHeader(signed, NETWORK_ID);

    const balanceBefore = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [developerAVault],
    })) as bigint;

    const r200 = await httpGet(nodeServerAOrigin, { 'X-PAYMENT': header });
    expect(r200.status).toBe(200);
    expect(r200.body).toBe('ok');
    expect(r200.headers['x-payment-response']).toBeDefined();
    const xpr = r200.headers['x-payment-response']!;
    const xprDecoded = JSON.parse(Buffer.from(xpr, 'base64').toString('utf8')) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
    };
    expect(xprDecoded.success).toBe(true);
    expect(xprDecoded.network).toBe(NETWORK_ID);
    expect(xprDecoded.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(xprDecoded.payer.toLowerCase()).toBe(signed.authorization.from.toLowerCase());

    const balanceAfter = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [developerAVault],
    })) as bigint;
    expect(balanceAfter - balanceBefore).toBe(PRICE_BASE_UNITS);

    const authState = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function authorizationState(address,bytes32) view returns (bool)']),
      functionName: 'authorizationState',
      args: [signed.authorization.from, nonce],
    })) as boolean;
    expect(authState).toBe(true);
  });

  it('fastify happy path: 402 → sign (fresh nonce) → 200; vault balance grows; authorizationState true', async () => {
    if (state === undefined) throw new Error('state not initialized');
    const { publicClient, usdcAddress, developerAVault, fastifyServerAOrigin } = state;

    const r402 = await httpGet(fastifyServerAOrigin);
    expect(r402.status).toBe(402);
    expect((r402.body as Record<string, unknown>)['error']).toBe('payment_required');

    const nonce = randomNonceHex();
    const signed = await signEip3009Authorization({
      payerPk: ANVIL_KEYS[2],
      to: developerAVault,
      value: PRICE_BASE_UNITS,
      nonce,
      usdcAddress,
      usdcName: 'USD Coin',
      usdcVersion: '2',
      chainId: CHAIN_ID,
    });
    const header = encodeXPaymentHeader(signed, NETWORK_ID);

    const balanceBefore = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [developerAVault],
    })) as bigint;

    const r200 = await httpGet(fastifyServerAOrigin, { 'X-PAYMENT': header });
    expect(r200.status).toBe(200);
    expect(r200.body).toBe('ok');
    expect(r200.headers['x-payment-response']).toBeDefined();
    const xpr = r200.headers['x-payment-response']!;
    const xprDecoded = JSON.parse(Buffer.from(xpr, 'base64').toString('utf8')) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
    };
    expect(xprDecoded.success).toBe(true);
    expect(xprDecoded.network).toBe(NETWORK_ID);
    expect(xprDecoded.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(xprDecoded.payer.toLowerCase()).toBe(signed.authorization.from.toLowerCase());

    const balanceAfter = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [developerAVault],
    })) as bigint;
    expect(balanceAfter - balanceBefore).toBe(PRICE_BASE_UNITS);

    const authState = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function authorizationState(address,bytes32) view returns (bool)']),
      functionName: 'authorizationState',
      args: [signed.authorization.from, nonce],
    })) as boolean;
    expect(authState).toBe(true);
  });

  it('cross-adapter NonceStore replay rejection: pay via node-http, retry IDENTICAL X-PAYMENT on fastify → 402 nonce_already_used', async () => {
    if (state === undefined) throw new Error('state not initialized');
    const { usdcAddress, developerAVault, nodeServerAOrigin, fastifyServerAOrigin } = state;

    const nonce = randomNonceHex();
    const signed = await signEip3009Authorization({
      payerPk: ANVIL_KEYS[2],
      to: developerAVault,
      value: PRICE_BASE_UNITS,
      nonce,
      usdcAddress,
      usdcName: 'USD Coin',
      usdcVersion: '2',
      chainId: CHAIN_ID,
    });
    const header = encodeXPaymentHeader(signed, NETWORK_ID);

    // Pay through Node http first.
    const r1 = await httpGet(nodeServerAOrigin, { 'X-PAYMENT': header });
    expect(r1.status).toBe(200);

    // Replay the EXACT SAME header on the Fastify endpoint — must be rejected
    // by the process-singleton NonceStore.
    const r2 = await httpGet(fastifyServerAOrigin, { 'X-PAYMENT': header });
    expect(r2.status).toBe(402);
    expect((r2.body as Record<string, unknown>)['error']).toBe('nonce_already_used');
  });

  it('vault_not_deployed rejection: developer EOA has never called register() → 402 vault_not_deployed', async () => {
    if (state === undefined) throw new Error('state not initialized');
    const { usdcAddress, nodeServerBOrigin } = state;

    const developerBVault = '0x0000000000000000000000000000000000000000' as const;

    // Sign for the (non-existent) developer B vault — middleware will reject
    // before verify even runs, since factory.vaults(devB) === 0x0.
    const nonce = randomNonceHex();
    const signed = await signEip3009Authorization({
      payerPk: ANVIL_KEYS[2],
      to: developerBVault,
      value: PRICE_BASE_UNITS,
      nonce,
      usdcAddress,
      usdcName: 'USD Coin',
      usdcVersion: '2',
      chainId: CHAIN_ID,
    });
    const header = encodeXPaymentHeader(signed, NETWORK_ID);

    const r = await httpGet(nodeServerBOrigin, { 'X-PAYMENT': header });
    expect(r.status).toBe(402);
    expect((r.body as Record<string, unknown>)['error']).toBe('vault_not_deployed');
  });

  it('paused rejection: factory.pause() → wait for cache TTL → signed request → 402 paused', async () => {
    if (state === undefined) throw new Error('state not initialized');
    const {
      publicClient,
      walletOwner,
      factoryAddress,
      usdcAddress,
      developerAVault,
      nodeServerPausedOrigin,
    } = state;

    // Pause the factory.
    const pauseHash = await walletOwner.writeContract({
      account: walletOwner.account!,
      chain: null,
      address: factoryAddress,
      abi: parseAbi(['function pause()']),
      functionName: 'pause',
      args: [],
    });
    await publicClient.waitForTransactionReceipt({ hash: pauseHash });

    try {
      // Confirm on-chain paused state.
      const paused = (await publicClient.readContract({
        address: factoryAddress,
        abi: parseAbi(['function paused() view returns (bool)']),
        functionName: 'paused',
      })) as boolean;
      expect(paused).toBe(true);

      // Wait for the middleware's 5 s factory-state cache TTL to expire.
      await new Promise((r) => setTimeout(r, 5_500));

      // Issue a signed request — middleware re-reads factory state, sees
      // `paused=true`, returns 402 paused.
      const nonce = randomNonceHex();
      const signed = await signEip3009Authorization({
        payerPk: ANVIL_KEYS[2],
        to: developerAVault,
        value: PRICE_BASE_UNITS,
        nonce,
        usdcAddress,
        usdcName: 'USD Coin',
        usdcVersion: '2',
        chainId: CHAIN_ID,
      });
      const header = encodeXPaymentHeader(signed, NETWORK_ID);

      const r = await httpGet(nodeServerPausedOrigin, { 'X-PAYMENT': header });
      expect(r.status).toBe(402);
      expect((r.body as Record<string, unknown>)['error']).toBe('paused');
    } finally {
      // Unpause so leftover suite state doesn't poison parallel reruns.
      const unpauseHash = await walletOwner.writeContract({
        account: walletOwner.account!,
        chain: null,
        address: factoryAddress,
        abi: parseAbi(['function unpause()']),
        functionName: 'unpause',
        args: [],
      });
      await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
    }
  });
});
