/**
 * RSSHub REAL L3+L4 — live RSSHub + crawler-boundary citation -> on-chain settle.
 *
 * A crawler fetches a feed item from a live RSSHub, grounds an answer in it, and
 * POSTs a citation ({crawlerId, link, author}) to our /citation sidecar, which
 * tolls the source author. The integration shape is crawler-side (no RSSHub fork
 * change); this proves the toll settles for a REAL RSSHub-served item.
 *
 * Proven 2026-06-21: live RSSHub /test/1 item (author DIYgod1) -> /citation toll
 * 5000 -> facilitator -> on-chain settle -> author paid 5000 micro-USDC.
 *
 * PREREQUISITES (acceptance harness; needs Docker):
 *   1. dockerd (root):  nohup dockerd >/tmp/dockerd.log 2>&1 &
 *   2. anvil on :8545:  anvil --chain-id 31337 --port 8545 --silent &
 *   3. contracts + packages built (see HANDOFF bootstrap).
 *   4. RSSHub (host net; DISABLE_IPV6 is required where the host has no IPv6 -
 *      otherwise RSSHub binds :: and never serves on 127.0.0.1):
 *        docker run -d --name rsshub-l3 --network host -e NODE_ENV=production \
 *          -e DISABLE_IPV6=true ghcr.io/diygod/rsshub:latest
 * Run from the repo root:  node packages/integrations/scripts/e2e-rsshub-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, createSidecarServer, mapResolver, citationRoute } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const RSS = 'http://localhost:1200';
const CRAWLER = 'gpt-crawler';
const TOLL = 5000n; // micro-USDC per grounded citation
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function sendTx(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }

async function main() {
  const usdcArt = art('MockUSDC.sol/MockUSDC.json'), facArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. Crawler fetches a REAL RSSHub feed item...');
  const feed = await (await fetch(`${RSS}/test/1?format=json`)).json();
  const item = feed.items[0];
  const author = (item.authors && item.authors[0] && item.authors[0].name) || item.author;
  console.log('   item url:', item.url, '| author:', author);

  console.log('2. Deploy rail + grant...');
  const usdc = await deploy(DEPLOYER, usdcArt, []); const factory = await deploy(DEPLOYER, facArt, [usdc]);
  await sendTx(DEPLOYER, usdc, usdcArt.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });

  console.log('3. Facilitator + REAL sidecar (citationRoute)...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const reporter = createReporter({ facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k', resolvePayer: mapResolver({ [CRAWLER]: viewer }), resolveCreator: mapResolver({ [author]: STREAMER }) });
  const sidecar = createSidecarServer([citationRoute(reporter, { toll: TOLL })]);
  await new Promise((r) => sidecar.listen(8410, () => r(null)));

  console.log('4. Crawler grounds an answer in the item -> POST /citation...');
  const res = await (await fetch('http://localhost:8410/citation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ crawlerId: CRAWLER, link: item.url, author }) })).json();
  console.log('   citation outcome:', JSON.stringify(res));
  if (res.status !== 'charged') throw new Error('citation not charged');

  console.log('5. Flush + assert on-chain settle...');
  const results = await fac.service.flushAll();
  const bal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [STREAMER] });
  if (!(results.length === 1 && results[0].ok)) throw new Error('no settle');
  if (bal !== TOLL) throw new Error(`expected ${TOLL} got ${bal}`);
  sidecar.close();
  fac.server.close();
  console.log(`\nREAL RSSHUB L3 PASS: crawler cites a live RSSHub item -> /citation toll -> facilitator -> on-chain settle -> author paid ${bal} micro-USDC`);
  process.exit(0);
}
main().catch((e) => { console.error('L3 ERROR:', e); process.exit(1); });
