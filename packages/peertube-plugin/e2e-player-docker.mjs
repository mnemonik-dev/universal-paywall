/**
 * PeerTube REAL L3+L4 — live PeerTube + the plugin + a REAL headless browser player.
 *
 * Unlike scripted /views POSTs (which PeerTube's view-throttle ignores), this plays
 * the video in real headless Chromium so PeerTube's viewer-stats accumulate past the
 * `count_view_after` threshold -> a COUNTED view -> the plugin's
 * `action:api.video.viewed` hook fires -> charge -> on-chain settle.
 *
 * Proven 2026-06-22 (PeerTube 7.3.0): real browser player -> counted view -> plugin
 * -> facilitator -> channel paid on-chain. (This run also surfaced + fixed a real
 * bug: the hook's `video` is an MVideoImmutable with NO channelId, so the plugin
 * now keys the creator on `video.channelId ?? video.id`.)
 *
 * PREREQUISITES (acceptance harness; needs Docker + Playwright chromium):
 *   1. dockerd (root); 2. anvil :8545; 3. contracts + packages built.
 *   4. PeerTube stack (postgres + redis + peertube, transcoding off) with the plugin
 *      installed + configured, and a VP9/Opus webm uploaded (Chromium-decodable).
 *      See work/creator-platform-integrations/testing-plan.md (PeerTube row) for the
 *      full bring-up; write {uuid, shortUUID, id} to /tmp/pt_video.
 *   IMPORTANT: each (session/IP, video) counts once — use a FRESH video per run.
 * Run from repo root: node packages/peertube-plugin/e2e-player-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const P = 'http://localhost:9000';
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function txw(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const vid = JSON.parse(readFileSync('/tmp/pt_video', 'utf8')); // {uuid, shortUUID, id}
  const usdcArt = art('MockUSDC.sol/MockUSDC.json'), facArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. rail + grant + facilitator (plugin is configured to charge this facilitator)...');
  const usdc = await deploy(DEPLOYER, usdcArt, []); const factory = await deploy(DEPLOYER, facArt, [usdc]);
  await txw(DEPLOYER, usdc, usdcArt.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));

  console.log('2. real headless browser player: play past the view threshold...');
  const ctx = await chromium.launchPersistentContext(`/tmp/pt-pw-${Date.now()}`, { headless: false, args: ['--headless=new', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await ctx.newPage();
  await page.goto(`${P}/w/${vid.shortUUID}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('video', { timeout: 20000 });
  await page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; return v.play().catch(() => {}); });
  for (let i = 0; i < 26; i++) { const ct = await page.evaluate(() => { const v = document.querySelector('video'); return v ? v.currentTime : 0; }); if (ct > 15) break; await sleep(1500); }

  console.log('3. poll for the counted view -> hook -> charge -> settle...');
  let ok = false;
  for (let i = 0; i < 30; i++) {
    await fac.service.flushAll();
    const bal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [STREAMER] });
    if (bal > 0n) { console.log(`\nREAL PEERTUBE L3+L4 PASS: headless browser player -> counted view -> action:api.video.viewed -> facilitator -> on-chain settle -> channel paid ${bal} micro-USDC`); ok = true; break; }
    await sleep(2000);
  }
  await ctx.close();
  fac.server.close();
  if (!ok) console.error('no settle (a counted view needs ~10s watch time on a FRESH video)');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('L3 ERROR:', e && e.message); process.exit(1); });
