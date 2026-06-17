/**
 * Arc Testnet live e2e — gated on `ARC_TESTNET_E2E === '1'`.
 *
 * Runs in the nightly job against the live Arc Testnet deployment. The
 * describe block is reported as SKIPPED when the flag is absent so the
 * default `npm test` invocation never blocks on a missing live RPC.
 *
 * Required env vars (canonical names per systemic-fix §3 + iter-3 addendum):
 *   - `ARC_RPC_URL` — the Arc Testnet RPC (defaults to
 *                    `https://rpc.testnet.arc.network`).
 *   - `PAYWALL_RELAYER_KEY` — facilitator relayer signer hex (canonical
 *                            runtime env var; wrapped in OpaqueRelayerKey).
 *   - `ARC_TESTNET_PAYER_PK` — payer signer hex (test-only; NEVER in the
 *                              canonical runtime env-var table).
 *   - `ARC_TESTNET_DEVELOPER_EOA` — developer EOA whose live vault receives
 *                                   settle (test-only).
 *   - `PAYMENT_SPLITTER_FACTORY_ADDRESS` — defensive override; if absent the
 *                                          test reads from `NETWORKS['arc-testnet']`
 *                                          (Task 11's deploy script patches
 *                                          this address in place).
 *
 * Asserts:
 *   - 402 body matches the vendored x402 v1 JSON Schema (via ajv).
 *   - 200 response carries a base64-JSON `X-PAYMENT-RESPONSE` header.
 *   - On-chain `usdc.balanceOf(vault)` increased by exactly `value`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http, { type Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { createPublicClient, http as viemHttp, parseAbi, toHex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import Ajv, { type ValidateFunction } from 'ajv';

import { NETWORKS, OpaqueRelayerKey, withPaywall } from '@universal-paywall/middleware';
import type { PaywallConfig } from '@universal-paywall/middleware';

const SHOULD_RUN = process.env['ARC_TESTNET_E2E'] === '1';

// Module-level counter used by the "skipped-without-env-flag" assertion in
// the default `npm test` run. The inner suite increments this on each `it`
// entry; when SHOULD_RUN is false the counter must stay at 0.
let runCounter = 0;

// ─── Helpers (file-scope so the describe block stays tidy) ───────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`arc-testnet-e2e: ${name} is required when ARC_TESTNET_E2E=1`);
  }
  return v;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

// `describe.skipIf(true)` reports the block as SKIPPED in the vitest reporter
// — not as zero tests run and not as failed. When the flag IS '1' the
// predicate is false and the suite runs.
describe.skipIf(!SHOULD_RUN)('arc testnet e2e', () => {
  let server: HttpServer | undefined;
  let serverOrigin = '';
  let publicClient: PublicClient | undefined;
  let usdcAddress: `0x${string}` = '0x0000000000000000000000000000000000000000';
  let chainId = 0;
  let usdcName = '';
  let usdcVersion = '';
  let vaultAddress: `0x${string}` = '0x0000000000000000000000000000000000000000';
  let payerAccount: ReturnType<typeof privateKeyToAccount> | undefined;
  let validate402: ValidateFunction | undefined;
  const PRICE_USD = '0.01';
  const PRICE_BASE_UNITS = 10_000n;

  beforeAll(async () => {
    // Resolve canonical env vars.
    const rpcUrl = process.env['ARC_RPC_URL'] ?? 'https://rpc.testnet.arc.network';
    const relayerKeyHex = requireEnv('PAYWALL_RELAYER_KEY');
    const payerPkHex = requireEnv('ARC_TESTNET_PAYER_PK') as `0x${string}`;
    const developerEoa = requireEnv('ARC_TESTNET_DEVELOPER_EOA') as `0x${string}`;

    // Resolve factory address — env override takes priority, otherwise
    // read from the NETWORKS registry (Task 11's deploy script patches the
    // sentinel 0x0 to the live address).
    const arcRow = (NETWORKS as Record<string, unknown>)['arc-testnet'] as {
      chainId: number;
      usdcAddress: `0x${string}`;
      usdcEip712Name: string;
      usdcEip712Version: string;
      factoryAddress: `0x${string}`;
    };
    const factoryAddress = (process.env['PAYMENT_SPLITTER_FACTORY_ADDRESS'] ??
      arcRow.factoryAddress) as `0x${string}`;
    if (factoryAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error(
        'arc-testnet-e2e: factoryAddress is the sentinel 0x0 — run Task 11 deploy first OR set PAYMENT_SPLITTER_FACTORY_ADDRESS',
      );
    }

    chainId = arcRow.chainId;
    usdcAddress = arcRow.usdcAddress;
    usdcName = arcRow.usdcEip712Name;
    usdcVersion = arcRow.usdcEip712Version;

    publicClient = createPublicClient({
      transport: viemHttp(rpcUrl),
    }) as PublicClient;

    // Resolve the developer's live vault address.
    vaultAddress = (await publicClient.readContract({
      address: factoryAddress,
      abi: parseAbi(['function vaults(address) view returns (address)']),
      functionName: 'vaults',
      args: [developerEoa],
    })) as `0x${string}`;
    if (vaultAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error(
        `arc-testnet-e2e: developer ${developerEoa} has no registered vault (factory.vaults(eoa) === 0x0)`,
      );
    }

    // Build PaywallConfig.
    payerAccount = privateKeyToAccount(payerPkHex);
    const config: PaywallConfig = {
      price: PRICE_USD,
      developerEoa,
      network: 'arc-testnet',
      facilitator: {
        mode: 'inline',
        relayerKey: new OpaqueRelayerKey(relayerKeyHex),
        rpcUrl,
      },
    };

    // Spin up a Node http server wrapping `withPaywall`.
    server = http.createServer(
      withPaywall((_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('ok');
      }, config),
    );
    const port = await listenEphemeral(server);
    serverOrigin = `http://127.0.0.1:${port}/resource`;

    // Compile the vendored x402 v1 JSON Schema for the 402 body assertion.
    const schemaPath = path.resolve(__dirname, '..', 'fixtures', 'x402-v1.schema.json');
    const schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    validate402 = ajv.compile({
      ...(schemaJson as Record<string, unknown>),
      $ref: '#/definitions/ChallengeBody',
    });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it('402 body matches the x402 v1 JSON Schema', async () => {
    runCounter += 1;
    const r = await httpGet(serverOrigin);
    expect(r.status).toBe(402);
    if (validate402 === undefined) throw new Error('ajv validator not initialized');
    const ok = validate402(r.body);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error('[arc-testnet-e2e] 402 body schema errors:', validate402.errors);
    }
    expect(ok).toBe(true);
  });

  it('live settle returns 200 with X-PAYMENT-RESPONSE and on-chain vault balance increases by value', async () => {
    runCounter += 1;
    if (publicClient === undefined || payerAccount === undefined) {
      throw new Error('beforeAll state missing');
    }

    const balanceBefore = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [vaultAddress],
    })) as bigint;

    const nonce = randomNonceHex();
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);

    const signature = await payerAccount.signTypedData({
      domain: {
        name: usdcName,
        version: usdcVersion,
        chainId,
        verifyingContract: usdcAddress,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payerAccount.address,
        to: vaultAddress,
        value: PRICE_BASE_UNITS,
        validAfter,
        validBefore,
        nonce,
      },
    });

    const wire = {
      x402Version: 1,
      scheme: 'exact',
      network: 'arc-testnet',
      payload: {
        signature,
        authorization: {
          from: payerAccount.address,
          to: vaultAddress,
          value: PRICE_BASE_UNITS.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
    const header = Buffer.from(JSON.stringify(wire), 'utf8').toString('base64');

    const r = await httpGet(serverOrigin, { 'X-PAYMENT': header });
    expect(r.status).toBe(200);
    expect(r.headers['x-payment-response']).toBeDefined();
    const xpr = r.headers['x-payment-response']!;
    const decoded = JSON.parse(Buffer.from(xpr, 'base64').toString('utf8')) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
    };
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(decoded.payer.toLowerCase()).toBe(payerAccount.address.toLowerCase());

    const balanceAfter = (await publicClient.readContract({
      address: usdcAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [vaultAddress],
    })) as bigint;
    expect(balanceAfter - balanceBefore).toBe(PRICE_BASE_UNITS);
  });
});

// ─── Skip-gate assertion (runs in the default CI invocation) ─────────────────
//
// When `ARC_TESTNET_E2E` is NOT '1' the gated describe above is skipped by
// vitest's `describe.skipIf`. We verify that behavior structurally: the
// module-level `runCounter` must stay at 0 (no `it` bodies execute), and the
// SHOULD_RUN gate must read false.
describe('arc testnet e2e gate', () => {
  it('skipped without env flag (default CI invocation)', () => {
    if (SHOULD_RUN) {
      // When the flag IS set we only assert that the gate would NOT skip —
      // the gated describe above is responsible for actual coverage.
      expect(SHOULD_RUN).toBe(true);
      return;
    }
    expect(SHOULD_RUN).toBe(false);
    expect(runCounter).toBe(0);
  });
});
