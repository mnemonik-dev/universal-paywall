/**
 * Vertical loop on anvil: proves a creator-platform sidecar settles through the
 * rail. An Owncast presence event flows:
 *
 *   viewer stakes+grants (agent) → OwncastPresenceMeter → reporter → SDK charge
 *   → facilitator batches → settle on-chain → streamer paid
 *
 * Prereq: anvil on http://127.0.0.1:8545 (chain 31337); agent + facilitator +
 * integrations built. Run: npx tsx packages/integrations/scripts/e2e-integration-anvil.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, mapResolver, OwncastPresenceMeter } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
// Public anvil dev keys (accounts #0–#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FACILITATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

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

  console.log('Start facilitator + build Owncast sidecar reporter...');
  const fac = createFacilitator({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    facilitatorKey: FACILITATOR_KEY,
    stakeVaultFactory: factory,
    apiKeys: ['k'],
    batch: { maxCharges: 100, maxAgeMs: 1 },
  });
  await new Promise((res) => fac.server.listen(8402, () => res(null)));

  const reporter = createReporter({
    facilitatorUrl: 'http://127.0.0.1:8402',
    apiKey: 'k',
    resolvePayer: mapResolver({ viewer1: viewer }),
    resolveCreator: mapResolver({ streamer: STREAMER }),
  });
  const meter = new OwncastPresenceMeter(reporter, { ratePerSecond: RATE, streamerKey: 'streamer' });

  console.log('Owncast: viewer present for 60s...');
  await meter.handle({ type: 'USER_JOINED', eventData: { user: { id: 'viewer1' } } }, 1000);
  const outcome = await meter.handle({ type: 'USER_PARTED', eventData: { user: { id: 'viewer1' } } }, 1060);
  assert(outcome?.status === 'charged', 'sidecar reported a 60s presence charge');

  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled the sidecar charge on-chain');

  const streamerBal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [STREAMER] });
  const expected = 60n * RATE;
  assert(streamerBal === expected, `streamer paid ${expected} on-chain (got ${streamerBal})`);

  fac.server.close();
  console.log('\nINTEGRATION E2E PASS: Owncast event → sidecar → facilitator → on-chain settle → streamer paid');
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
