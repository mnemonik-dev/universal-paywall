/**
 * Owncast L3/L4 acceptance loop.
 *
 * Upgrades the in-process integration e2e to the full production path: the event
 * arrives over **real HTTP** at a **real sidecar** (`createSidecarServer` +
 * `owncastRoute`), as the **byte-exact JSON Owncast actually posts** to a
 * registered webhook. Payload shape is grounded in the Owncast fork:
 *   services/webhooks/webhooks.go  (WebhookEvent / WebhookUserJoinedEventData)
 *   services/webhooks/chat.go      (SendChatEventUserJoined/Parted)
 *   models/user.go                 (User.id)
 *
 *   real Owncast webhook bytes  --HTTP-->  POST /owncast (sidecar)
 *     -> OwncastPresenceMeter -> reporter -> SDK charge
 *     -> facilitator batches -> StakeVault.settle on-chain -> streamer paid
 *
 * Note: this environment has no Docker daemon, so the Owncast *process* itself is
 * not run here; instead we replay the exact bytes it emits against the real
 * sidecar HTTP server (L3 fidelity at the wire). The real-instance registration
 * step (POST /api/admin/webhooks/create) is in deploy/owncast/register-webhook.sh.
 *
 * Prereq: anvil on http://127.0.0.1:8545 (chain 31337); packages built.
 * Run: npx tsx packages/integrations/scripts/e2e-owncast-acceptance-anvil.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, createSidecarServer, mapResolver, OwncastPresenceMeter, owncastRoute } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FACILITATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const SIDECAR_PORT = 8410;
const FACILITATOR_PORT = 8402;
const VIEWER_ID = 'viewer1';
const JOIN_AT = '2026-06-21T19:00:00Z';
const PART_AT = '2026-06-21T19:01:00Z'; // +60s

const chain = defineChain({
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
function artifact(p) {
  const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}
async function deploy(key, art, args) {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(key, address, abi, fn, args) {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await w.writeContract({ address, abi, functionName: fn, args, account, chain });
  await pub.waitForTransactionReceipt({ hash });
}
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('  ok:', msg);
}

/** The exact JSON Owncast posts for a presence event (full eventData envelope). */
function owncastWebhook(type, timestamp) {
  return {
    type,
    eventData: {
      status: { online: true, viewerCount: 1, lastConnectTime: timestamp },
      serverURL: 'http://localhost:8080',
      id: `evt-${type}-${timestamp}`,
      timestamp,
      user: {
        id: VIEWER_ID,
        displayName: 'alice',
        createdAt: '2026-06-21T18:00:00Z',
        previousNames: ['alice'],
        displayColor: 100,
        isBot: false,
        authenticated: false,
      },
    },
  };
}

async function postWebhook(body) {
  const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/owncast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function main() {
  const mockUsdc = artifact('MockUSDC.sol/MockUSDC.json');
  const factoryArt = artifact('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address;
  const facilitatorAddr = privateKeyToAccount(FACILITATOR_KEY).address;
  const RATE = 1_000n; // micro-USDC per second
  const CAP = 1_000_000n;

  console.log('Deploy rail + mint USDC to viewer...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await send(DEPLOYER, usdc, mockUsdc.abi, 'mint', [viewer, 2_000_000n]);

  console.log('Viewer stakes + grants (agent helper)...');
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facilitatorAddr, stakeVaultFactory: factory, recommendedCap: CAP, validForSeconds: 3600 });

  console.log('Start facilitator...');
  const fac = createFacilitator({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    facilitatorKey: FACILITATOR_KEY,
    stakeVaultFactory: factory,
    apiKeys: ['k'],
    batch: { maxCharges: 100, maxAgeMs: 1 },
  });
  await new Promise((res) => fac.server.listen(FACILITATOR_PORT, () => res(null)));

  console.log('Start REAL Owncast sidecar HTTP server (createSidecarServer + owncastRoute)...');
  const reporter = createReporter({
    facilitatorUrl: `http://127.0.0.1:${FACILITATOR_PORT}`,
    apiKey: 'k',
    resolvePayer: mapResolver({ [VIEWER_ID]: viewer }),
    resolveCreator: mapResolver({ streamer: STREAMER }),
  });
  const meter = new OwncastPresenceMeter(reporter, { ratePerSecond: RATE, streamerKey: 'streamer' });
  const sidecar = createSidecarServer([owncastRoute(meter)]);
  await new Promise((res) => sidecar.listen(SIDECAR_PORT, () => res(null)));

  console.log('Owncast posts real webhook bytes: USER_JOINED then USER_PARTED (+60s)...');
  const joined = await postWebhook(owncastWebhook('USER_JOINED', JOIN_AT));
  assert(joined.status === 200, `sidecar accepted USER_JOINED webhook over HTTP (200)`);
  const parted = await postWebhook(owncastWebhook('USER_PARTED', PART_AT));
  assert(parted.status === 200, `sidecar accepted USER_PARTED webhook over HTTP (200)`);
  assert(parted.json?.status === 'charged', `sidecar reported a presence charge (got ${parted.json?.status})`);
  assert(BigInt(parted.json?.amount ?? 0) === 60n * RATE, `charge amount is 60s * rate = ${60n * RATE}`);

  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled the sidecar charge on-chain');

  const streamerBal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [STREAMER] });
  const expected = 60n * RATE;
  assert(streamerBal === expected, `streamer paid ${expected} on-chain (got ${streamerBal})`);

  sidecar.close();
  fac.server.close();
  console.log('\nOWNCAST ACCEPTANCE PASS: real webhook bytes -> HTTP sidecar -> facilitator -> on-chain settle -> streamer paid');
  process.exit(0);
}

main().catch((e) => {
  console.error('ACCEPTANCE ERROR:', e);
  process.exit(1);
});
