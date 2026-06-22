/**
 * Immich REAL L3+L4 — live instance + the reverse-proxy wrapper, on-chain settle.
 *
 * Puts `createImmichProxy` in front of a live Immich; an external viewer resolves a
 * shared-link asset THROUGH the proxy, which meters a per-resolve license fee to
 * the asset owner (EXIF artist when present). No edit to Immich - it attaches at
 * the HTTP boundary.
 *
 * Proven 2026-06-21: live Immich (server + vectorchord postgres + redis), real
 * uploaded photo + shared link, resolved via the proxy -> owner paid 25000.
 *
 * PREREQUISITES (acceptance harness; needs Docker):
 *   1. dockerd (root):  nohup dockerd >/tmp/dockerd.log 2>&1 &
 *   2. anvil on :8545:  anvil --chain-id 31337 --port 8545 --silent &
 *   3. contracts + packages built (see HANDOFF bootstrap).
 *   4. A live Immich (host net) + admin + an asset + a shared link:
 *        docker run -d --name immich-db --network host -e POSTGRES_USER=postgres \
 *          -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=immich -e POSTGRES_INITDB_ARGS=--data-checksums \
 *          ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
 *        docker run -d --name immich-redis --network host redis:7-alpine
 *        docker run -d --name immich-server --network host -e DB_HOSTNAME=127.0.0.1 \
 *          -e DB_USERNAME=postgres -e DB_PASSWORD=postgres -e DB_DATABASE_NAME=immich \
 *          -e REDIS_HOSTNAME=127.0.0.1 -e IMMICH_MACHINE_LEARNING_ENABLED=false \
 *          -v /tmp/immich-upload:/usr/src/app/upload ghcr.io/immich-app/immich-server:release
 *        # POST /api/auth/admin-sign-up, /api/auth/login -> token;
 *        # POST /api/assets (multipart) -> assetId; POST /api/shared-links {type:INDIVIDUAL,assetIds}
 *        # -> key. Write {assetId, ownerId, artist, key} to /tmp/immich_ctx.json.
 * Run from repo root: node packages/integrations/scripts/e2e-immich-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, mapResolver, createImmichProxy } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const IMMICH = 'http://localhost:2283';
const FEE = 25_000n;
const RESOLVER = 'agent-buyer';
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const OWNER_WALLET = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function txw(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = JSON.parse(readFileSync('/tmp/immich_ctx.json', 'utf8')); // {assetId, ownerId, artist?, key}
  const usdcArt = art('MockUSDC.sol/MockUSDC.json'), facArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. rail + grant + facilitator...');
  const usdc = await deploy(DEPLOYER, usdcArt, []); const factory = await deploy(DEPLOYER, facArt, [usdc]);
  await txw(DEPLOYER, usdc, usdcArt.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));

  console.log('2. start the Immich reverse-proxy (owner', ctx.ownerId.slice(0, 8) + '... -> wallet)...');
  const reporter = createReporter({
    facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k',
    resolvePayer: mapResolver({ [RESOLVER]: viewer }),
    resolveCreator: mapResolver({ [ctx.ownerId]: OWNER_WALLET, ...(ctx.artist ? { [ctx.artist]: OWNER_WALLET } : {}) }),
  });
  const proxy = createServer(createImmichProxy({ upstreamUrl: IMMICH, reporter, licenseFee: FEE }));
  await new Promise((r) => proxy.listen(8410, () => r(null)));

  console.log('3. external viewer resolves the shared asset THROUGH the proxy...');
  const res = await fetch(`http://127.0.0.1:8410/api/assets/${ctx.assetId}/original?key=${encodeURIComponent(ctx.key)}`, { headers: { 'x-resolver-id': RESOLVER } });
  const bytes = (await res.arrayBuffer()).byteLength;
  if (res.status !== 200 || bytes === 0) throw new Error(`proxy did not serve the image (status ${res.status}, ${bytes} bytes)`);
  console.log('   proxied image: status 200,', bytes, 'bytes');

  console.log('4. meter -> charge -> settle...');
  for (let i = 0; i < 15; i++) {
    await fac.service.flushAll();
    const bal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [OWNER_WALLET] });
    if (bal > 0n) { console.log(`\nREAL IMMICH L3 PASS: shared-link resolve via reverse-proxy -> license fee -> facilitator -> on-chain settle -> owner paid ${bal} micro-USDC`); proxy.close(); fac.server.close(); process.exit(0); }
    await sleep(1000);
  }
  console.error('no charge — resolve not metered'); proxy.close(); fac.server.close(); process.exit(1);
}
main().catch((e) => { console.error('L3 ERROR:', e); process.exit(1); });
