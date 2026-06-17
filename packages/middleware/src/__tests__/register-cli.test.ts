/**
 * Spawn-based tests for `scripts/register.ts`.
 *
 * The CLI is exercised as a child process (per systemic-fix decision: single
 * vitest config, treat the CLI as an external binary). A local anvil node is
 * spawned in `beforeAll`; the PaymentSplitterFactory + a tiny mock USDC are
 * deployed programmatically via viem reading the forge artifact in
 * `contracts/out/PaymentSplitterFactory.sol/PaymentSplitterFactory.json`.
 *
 * Per iter-3 §11: `__dirname` replacement via `fileURLToPath(new URL(...))`.
 * Per iter-3 §12: `getRelayerKeySecret` lives at the internal relative path.
 *
 * If `anvil` is not on PATH, the suite skips with a clear message.
 */

import { spawn, type ChildProcessByStdio, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const REGISTER_TS = resolve(REPO_ROOT, 'scripts/register.ts');
const CONTRACTS_ROOT = resolve(REPO_ROOT, 'contracts');
const FACTORY_ARTIFACT = resolve(
  CONTRACTS_ROOT,
  'out/PaymentSplitterFactory.sol/PaymentSplitterFactory.json',
);

// Tiny ERC20 stub used purely so the factory's `IERC20` constructor arg is a
// real contract address. The CLI never calls any ERC20 method, so a minimal
// bytecode that simply has runtime code suffices.
// Source compiled: `contract M { function noop() external pure {} }` (we use
// a known-good runtime that has SOME code at the address — even a tiny EVM
// snippet works since the factory only stores the address.)
const MOCK_ERC20_BYTECODE: Hex =
  '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea264697066735822122000000000000000000000000000000000000000000000000000000000000000000064736f6c63430008140033';

const ANVIL_HOST = '127.0.0.1';
// Anvil canonical accounts — public, fixed across versions. OK to commit.
const DEPLOYER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYER_ADDR: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DEVELOPER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEVELOPER_ADDR: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TREASURY_ADDR: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const ANVIL_AVAILABLE = (() => {
  const probe = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
})();

const FACTORY_ARTIFACT_AVAILABLE = existsSync(FACTORY_ARTIFACT);

const describeIfReady = ANVIL_AVAILABLE && FACTORY_ARTIFACT_AVAILABLE ? describe : describe.skip;

if (!ANVIL_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn('[register-cli.test] anvil not installed; install foundry to run register-cli.test');
}
if (!FACTORY_ARTIFACT_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[register-cli.test] missing ${FACTORY_ARTIFACT}; run \`cd contracts && forge build\` first`,
  );
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectP);
    srv.listen(0, ANVIL_HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolveP(port));
      } else {
        srv.close(() => rejectP(new Error('failed to allocate free port')));
      }
    });
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
      });
      if (response.ok) return;
      lastErr = new Error(`status ${response.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`port ${host}:${port} not ready: ${(lastErr as Error)?.message ?? '?'}`);
}

interface DeployedFixture {
  port: number;
  rpcUrl: string;
  factoryAddress: Address;
  usdcAddress: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  anvilProc: ChildProcessByStdio<null, Readable, Readable>;
}

async function spawnAnvilAndDeploy(): Promise<DeployedFixture> {
  const port = await getFreePort();
  const anvilProc = spawn(
    'anvil',
    ['--chain-id', '31337', '--port', String(port), '--host', ANVIL_HOST],
    {
      cwd: CONTRACTS_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ) as ChildProcessByStdio<null, Readable, Readable>;

  // Drain stdout/stderr so the OS pipe buffer never fills (would freeze anvil).
  anvilProc.stdout.on('data', () => {});
  anvilProc.stderr.on('data', () => {});
  anvilProc.on('error', () => {});

  const rpcUrl = `http://${ANVIL_HOST}:${port}`;
  await waitForPort(ANVIL_HOST, port, 30_000);

  const chain = defineChain({
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account: deployerAccount,
    chain,
    transport: http(rpcUrl),
  });

  // 1. Deploy a tiny mock ERC20 so the factory constructor's IERC20 arg has
  //    code at the address (the constructor checks address != 0; no calls go
  //    through this contract during register()).
  const mockHash = await walletClient.deployContract({
    abi: [],
    bytecode: MOCK_ERC20_BYTECODE,
  });
  const mockReceipt = await publicClient.waitForTransactionReceipt({ hash: mockHash });
  const usdcAddress = mockReceipt.contractAddress as Address;
  if (!usdcAddress) throw new Error('mock USDC deploy returned no contractAddress');

  // 2. Deploy the factory using its forge artifact bytecode.
  interface ForgeArtifact {
    abi: readonly unknown[];
    bytecode: { object: Hex };
  }
  const artifact = JSON.parse(readFileSync(FACTORY_ARTIFACT, 'utf8')) as ForgeArtifact;
  const factoryHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [usdcAddress, TREASURY_ADDR, 50],
  });
  const factoryReceipt = await publicClient.waitForTransactionReceipt({
    hash: factoryHash,
  });
  const factoryAddress = factoryReceipt.contractAddress as Address;
  if (!factoryAddress) throw new Error('factory deploy returned no contractAddress');

  return {
    port,
    rpcUrl,
    factoryAddress,
    usdcAddress,
    publicClient,
    walletClient,
    anvilProc,
  };
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface SpawnRegisterOpts {
  registerKey?: string | undefined;
  factoryAddress: Address;
  rpcUrl: string;
  args?: string[];
}

async function runRegister(opts: SpawnRegisterOpts): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  if (opts.registerKey === undefined) {
    delete env['REGISTER_KEY'];
  } else {
    env['REGISTER_KEY'] = opts.registerKey;
  }
  env['TEST_FACTORY_ADDRESS'] = opts.factoryAddress;
  env['TEST_RPC_URL'] = opts.rpcUrl;
  env['UP_SUPPRESS_T3_NOTES'] = '1';

  const args = ['--network', 'test-anvil', ...(opts.args ?? [])];

  return await new Promise<CliResult>((resolveP, rejectP) => {
    const child = spawn('npx', ['tsx', REGISTER_TS, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', rejectP);
    child.on('close', (code) => {
      resolveP({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

describeIfReady('scripts/register.ts (CLI)', () => {
  let fixture: DeployedFixture;

  beforeAll(async () => {
    fixture = await spawnAnvilAndDeploy();
  }, 60_000);

  afterAll(async () => {
    if (!fixture?.anvilProc) return;
    fixture.anvilProc.kill('SIGTERM');
    const exited = new Promise<void>((resolveP) => {
      fixture.anvilProc.once('exit', () => resolveP());
    });
    const timer = new Promise<void>((resolveP) =>
      setTimeout(() => {
        try {
          fixture.anvilProc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolveP();
      }, 5_000),
    );
    await Promise.race([exited, timer]);
  });

  it('register_calls_factory — happy path produces non-zero vault and exits 0', async () => {
    // Use DEVELOPER_KEY (anvil account #1). The happy-path test happens to
    // emit "Tx: 0x<hash>" which is a 32-byte hex string — so we deliberately
    // do NOT apply the broad 0x{64} hex-pattern check here. Literal-substring
    // checks against the input key value are still the canonical key-leak
    // guard for this path; the broad-pattern check lives on the
    // already-registered output (no Tx line).
    const result = await runRegister({
      registerKey: DEVELOPER_KEY,
      factoryAddress: fixture.factoryAddress,
      rpcUrl: fixture.rpcUrl,
    });

    expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Registered. Vault: 0x');
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(DEVELOPER_KEY);
    expect(combined).not.toContain(DEVELOPER_KEY.slice(2));

    const vault = (await fixture.publicClient.readContract({
      abi: [
        {
          type: 'function',
          name: 'vaults',
          inputs: [{ name: 'd', type: 'address' }],
          outputs: [{ name: '', type: 'address' }],
          stateMutability: 'view',
        },
      ],
      address: fixture.factoryAddress,
      functionName: 'vaults',
      args: [DEVELOPER_ADDR],
    })) as Address;
    expect(vault).not.toBe(ZERO_ADDRESS);
  }, 60_000);

  it('register_handles_already_registered — second call exits 0 with informational message', async () => {
    // Self-sufficient: explicitly ensure DEVELOPER_KEY is registered first
    // (idempotent — no-op if a prior test already registered it), then
    // assert on the deterministic second invocation.
    await runRegister({
      registerKey: DEVELOPER_KEY,
      factoryAddress: fixture.factoryAddress,
      rpcUrl: fixture.rpcUrl,
    });

    const result = await runRegister({
      registerKey: DEVELOPER_KEY,
      factoryAddress: fixture.factoryAddress,
      rpcUrl: fixture.rpcUrl,
    });
    expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Already registered\. Vault: 0x[0-9a-fA-F]{40}/);
    // No Tx line emitted on the already-registered path — assert it.
    expect(result.stdout).not.toContain('Tx:');
  }, 60_000);

  it('register_never_prints_key — no 32-byte hex appears in stdout or stderr', async () => {
    // Run against the ALREADY-REGISTERED path so the deterministic output
    // is "Already registered. Vault: 0x..." (40 hex chars, not 64) — the
    // broad-pattern check is meaningful here because no legitimate 32-byte
    // hex (e.g. tx hash) can appear. Ensure registration first.
    await runRegister({
      registerKey: DEVELOPER_KEY,
      factoryAddress: fixture.factoryAddress,
      rpcUrl: fixture.rpcUrl,
    });

    const result = await runRegister({
      registerKey: DEVELOPER_KEY,
      factoryAddress: fixture.factoryAddress,
      rpcUrl: fixture.rpcUrl,
    });
    expect(result.code).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(DEVELOPER_KEY);
    expect(combined).not.toContain(DEVELOPER_KEY.slice(2));
    expect(combined).not.toMatch(/0x[0-9a-fA-F]{64}/);
  }, 60_000);

  it('register_rejects_malformed_key — exit 2, stderr omits the input', async () => {
    // Exercise multiple malformed shapes (per test-reviewer L1): pure
    // garbage, 0x-prefix with too-short length, and uppercase hex with bad
    // length. The CLI must reject all with exit 2 and never echo the input.
    const malformedInputs = [
      'not-a-key-totally-garbage',
      '0x' + 'a'.repeat(30), // 0x-prefix but only 30 hex chars
      '0xZZZ' + 'b'.repeat(61), // 0x-prefix, right length, non-hex chars
    ];
    for (const malformed of malformedInputs) {
      const result = await runRegister({
        registerKey: malformed,
        factoryAddress: fixture.factoryAddress,
        rpcUrl: fixture.rpcUrl,
      });
      expect(result.code, `input: ${malformed}`).toBe(2);
      expect(result.stderr).not.toContain(malformed);
      expect(result.stdout).not.toContain(malformed);
    }
  });

  it('register_handles_missing_key — exit 2 with canonical message', async () => {
    const result = await runRegister({
      registerKey: undefined,
      factoryAddress: fixture.factoryAddress,
      rpcUrl: fixture.rpcUrl,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('REGISTER_KEY env var missing or malformed');
  });

  it('register_rejects_disabled_network — arc-mainnet → exit 3', async () => {
    // We need to call register.ts WITHOUT the test-anvil bypass so the
    // production NETWORKS lookup runs. Use a runRegister variant that omits
    // --network=test-anvil.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      REGISTER_KEY: DEVELOPER_KEY,
      UP_SUPPRESS_T3_NOTES: '1',
    };
    const result = await new Promise<CliResult>((resolveP, rejectP) => {
      const child = spawn('npx', ['tsx', REGISTER_TS, '--network', 'arc-mainnet'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const so: Buffer[] = [];
      const se: Buffer[] = [];
      child.stdout.on('data', (c) => so.push(c as Buffer));
      child.stderr.on('data', (c) => se.push(c as Buffer));
      child.on('error', rejectP);
      child.on('close', (code) =>
        resolveP({
          code,
          stdout: Buffer.concat(so).toString('utf8'),
          stderr: Buffer.concat(se).toString('utf8'),
        }),
      );
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/disabled|unknown/i);
    // Per test-reviewer L2: even on the rejected-network path, no part of
    // the developer key may appear in either stream.
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(DEVELOPER_KEY);
    expect(combined).not.toContain(DEVELOPER_KEY.slice(2));
  });

  it('register_help_flag — --help prints usage and exits 0', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      UP_SUPPRESS_T3_NOTES: '1',
    };
    const result = await new Promise<CliResult>((resolveP, rejectP) => {
      const child = spawn('npx', ['tsx', REGISTER_TS, '--help'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const so: Buffer[] = [];
      const se: Buffer[] = [];
      child.stdout.on('data', (c) => so.push(c as Buffer));
      child.stderr.on('data', (c) => se.push(c as Buffer));
      child.on('error', rejectP);
      child.on('close', (code) =>
        resolveP({
          code,
          stdout: Buffer.concat(so).toString('utf8'),
          stderr: Buffer.concat(se).toString('utf8'),
        }),
      );
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('REGISTER_KEY');
    expect(result.stdout).toContain('ARC_RPC_URL');
  });

  it('register_never_prints_key_on_rpc_failure — error classification path scrubs hex keys', async () => {
    // Per security-auditor SA-T11-05: also exercise the failure path —
    // a valid REGISTER_KEY routed to an unreachable RPC must classify
    // through classifyError() without leaking a hex pattern.
    const result = await runRegister({
      registerKey: DEVELOPER_KEY,
      factoryAddress: fixture.factoryAddress,
      // Port 1 is reserved/unbindable; the viem client surfaces a connection
      // error that the CLI classifies as rpc_5xx / rpc_timeout / unknown.
      rpcUrl: 'http://127.0.0.1:1',
    });
    expect(result.code).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(DEVELOPER_KEY);
    expect(combined).not.toContain(DEVELOPER_KEY.slice(2));
    expect(combined).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(result.stderr).toMatch(/register_failed:/);
  }, 60_000);
});
