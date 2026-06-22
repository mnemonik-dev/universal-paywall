/**
 * Owncast REAL L3+L4 — live instance, real webhook, on-chain settle.
 *
 * Unlike e2e-owncast-acceptance-anvil.ts (which replays known bytes), this drives a
 * REAL Owncast container: brings the stream online (ffmpeg RTMP push), connects a
 * real chat websocket to fire a real USER_JOINED, disconnects to fire USER_PARTED
 * (10s prune), and asserts the streamer is paid on-chain for the real presence.
 *
 * Proven 2026-06-21: real bytes match the sidecar shape (type / eventData.user.id /
 * eventData.timestamp); 14s presence -> 14000 micro-USDC settled to the streamer.
 *
 * PREREQUISITES (this is an acceptance harness, NOT CI — it needs Docker):
 *   1. dockerd running:    nohup dockerd >/tmp/dockerd.log 2>&1 &   (root)
 *   2. anvil on :8545:     anvil --chain-id 31337 --port 8545 --silent &   (PATH=/tmp/foundry)
 *   3. contracts built:    (cd contracts && FOUNDRY_OFFLINE=true forge build)
 *   4. packages built:     npm run build -w @universal-paywall/{sdk,facilitator,agent,integrations}
 *   5. Owncast container (host net so it reaches the host sidecar + anvil):
 *        docker run -d --name owncast-l3 --network host owncast/owncast:latest
 * Run from the repo root:  node packages/integrations/scripts/e2e-owncast-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, createSidecarServer, mapResolver, OwncastPresenceMeter, owncastRoute } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const OWNCAST = 'http://localhost:8080';
const RATE = 1_000n; // micro-USDC per second
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FACILITATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(key, a, args) { const account = privateKeyToAccount(key); const w = createWalletClient({ account, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function send(key, address, abi, fn, args) { const account = privateKeyToAccount(key); const w = createWalletClient({ account, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mockUsdc = art('MockUSDC.sol/MockUSDC.json');
  const factoryArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address;
  const facilitatorAddr = privateKeyToAccount(FACILITATOR_KEY).address;

  console.log('1. Deploy rail + viewer stakes + grants...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await send(DEPLOYER, usdc, mockUsdc.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facilitatorAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });

  console.log('2. Register a real Owncast chat user...');
  const reg = await (await fetch(`${OWNCAST}/api/chat/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'l3viewer' }) })).json();
  console.log('   chat user id =', reg.id);

  console.log('3. Start facilitator + REAL sidecar (resolvePayer maps the real chat id)...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FACILITATOR_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const reporter = createReporter({ facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k', resolvePayer: mapResolver({ [reg.id]: viewer }), resolveCreator: mapResolver({ streamer: STREAMER }) });
  const meter = new OwncastPresenceMeter(reporter, { ratePerSecond: RATE, streamerKey: 'streamer' });
  const base = owncastRoute(meter);
  let charged = null;
  const sidecar = createSidecarServer([{ ...base, handle: async (ctx) => { console.log('   >>> REAL WEBHOOK BYTES:', JSON.stringify(ctx.body)); const out = await base.handle(ctx); if (out?.status === 'charged') charged = out; return out; } }]);
  await new Promise((r) => sidecar.listen(8410, () => r(null)));

  console.log('4. Register the webhook on the live Owncast (admin API)...');
  const auth = 'Basic ' + Buffer.from('admin:abc123').toString('base64');
  const wh = await fetch(`${OWNCAST}/api/admin/webhooks/create`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify({ url: 'http://localhost:8410/owncast', events: ['USER_JOINED', 'USER_PARTED'] }) });
  console.log('   webhook create status', wh.status);

  console.log('5. Bring the stream ONLINE (ffmpeg RTMP push inside the container)...');
  spawn('docker', ['exec', 'owncast-l3', 'ffmpeg', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-c:a', 'aac', '-f', 'flv', 'rtmp://localhost:1935/live/abc123'], { detached: true, stdio: 'ignore' }).unref();
  let online = false;
  for (let i = 0; i < 60; i++) { const s = await (await fetch(`${OWNCAST}/api/status`)).json(); if (s.online) { online = true; console.log('   ONLINE after', i, 's'); break; } await sleep(1000); }
  if (!online) throw new Error('stream did not go online');

  console.log('6. Connect a real chat websocket (fires real USER_JOINED webhook)...');
  const ws = new WebSocket(`ws://localhost:8080/ws?accessToken=${reg.accessToken}`);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws open timeout')), 10000); });
  console.log('   websocket open; present ~4s...');
  await sleep(4000);
  ws.close();
  console.log('7. Disconnected; waiting for USER_PARTED (10s prune timer)...');
  for (let i = 0; i < 20 && charged === null; i++) await sleep(1000);
  if (charged === null) throw new Error('no charge from real USER_PARTED within timeout');
  console.log('   CHARGE from real part:', JSON.stringify(charged, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  console.log('8. Flush facilitator + assert on-chain settle...');
  const results = await fac.service.flushAll();
  const bal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [STREAMER] });
  if (!(results.length === 1 && results[0].ok)) throw new Error('facilitator did not settle');
  if (bal <= 0n) throw new Error('streamer not paid');

  sidecar.close();
  fac.server.close();
  console.log('\nREAL OWNCAST L3 PASS: live stream + real chat join/part -> real webhook -> sidecar -> facilitator -> on-chain settle -> streamer paid', bal.toString());
  process.exit(0);
}
main().catch((e) => { console.error('L3 ERROR:', e); process.exit(1); });
