/**
 * Extension BROWSER E2E — the real MV3 runtime in headless Chromium.
 *
 * Loads the bundled extension as an unpacked MV3 add-on in a real Chromium, injects
 * config (incl. a managed session account) into chrome.storage, and invokes the
 * REAL background service-worker handler — which builds the PayerAgent (bundled
 * viem) IN THE BROWSER and auto-pays a real x402 resource:
 *
 *   loaded SW handler 'up:fetch' -> agent.fetchWithPaywall -> 402 -> on-chain
 *   create-vault+deposit+grant -> retry -> 200 -> facilitator settle -> creator paid
 *
 * Proves the shipped bundle actually runs in a browser (viem + agent + on-chain
 * signing + fetch in the SW sandbox), beyond the node handler E2E (e2e:anvil).
 *
 * Prereq: dockerd not needed; anvil on :8545; packages built; `npm run build`
 * (bundles dist/); Playwright chromium installed (PLAYWRIGHT_BROWSERS_PATH).
 * Run: node e2e-browser.mjs
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { withStakePaywall } from '@universal-paywall/resource-adapter';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const SESSION_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const CREATOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const PRICE = 50_000n;
const CAP = 1_000_000n;

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function send(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('  ok:', m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const usdcArt = art('MockUSDC.sol/MockUSDC.json');
  const factoryArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const session = privateKeyToAccount(SESSION_KEY).address;
  const facilitator = privateKeyToAccount(FAC_KEY).address;

  console.log('1. Deploy rail + mint USDC to the session account...');
  const usdc = await deploy(DEPLOYER, usdcArt, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await send(DEPLOYER, usdc, usdcArt.abi, 'mint', [session, 2_000_000n]);

  console.log('2. facilitator (8402) + x402 resource (3000)...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const resourceServer = createServer(withStakePaywall(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ paid: true })); },
    { price: PRICE, creator: CREATOR, recommendedCap: CAP, chain: { rpcUrl: RPC, chainId: CHAIN_ID, network: 'eip155:31337', asset: usdc, facilitatorAddress: facilitator, stakeVaultFactory: factory }, facilitator: { url: 'http://127.0.0.1:8402', apiKey: 'k' } },
  ));
  await new Promise((r) => resourceServer.listen(3000, () => r(null)));

  console.log('3. Launch headless Chromium with the bundled extension...');
  const extDir = join(here, 'dist');
  const ctx = await chromium.launchPersistentContext(join(here, '.pw-profile'), {
    headless: false,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
  console.log('   extension service worker:', sw.url().slice(0, 40) + '...');

  console.log('4. Inject config (managed session account) into chrome.storage...');
  await sw.evaluate(async (cfg) => {
    await chrome.storage.local.set(cfg);
  }, { rpcUrl: RPC, chainId: CHAIN_ID, stakeVaultFactory: factory, usdc, sessionPrivateKey: SESSION_KEY, allowList: [] });
  await sleep(500);

  console.log('5. Invoke the REAL in-browser handler: up:status, then up:fetch (auto-pay)...');
  const st = await sw.evaluate(() => globalThis.__upHandle({ type: 'up:status' }));
  assert(st.ok && st.payer.toLowerCase() === session.toLowerCase(), 'SW up:status returns the session-account payer');

  const out = await sw.evaluate(() => globalThis.__upHandle({ type: 'up:fetch', url: 'http://127.0.0.1:3000/paid' }));
  assert(out.ok && out.status === 200, `in-browser extension auto-paid -> 200 (got ${out.status} ${out.error || ''})`);
  assert(JSON.parse(out.body).paid === true, 'resource body returned through the in-browser extension');

  console.log('6. Assert on-chain settle...');
  for (let i = 0; i < 50 && fac.ledger.size() === 0; i++) await sleep(40);
  assert(fac.ledger.size() === 1, 'facilitator received the metered charge');
  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled on-chain');
  const creatorBal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [CREATOR] });
  assert(creatorBal === PRICE, `creator paid ${PRICE} on-chain (got ${creatorBal})`);

  await ctx.close();
  resourceServer.close();
  fac.server.close();
  console.log('\nEXTENSION BROWSER E2E PASS: loaded MV3 SW (bundled viem+agent) -> auto-pay x402 -> on-chain settle -> creator paid');
  process.exit(0);
}
main().catch((e) => { console.error('BROWSER E2E ERROR:', e); process.exit(1); });
