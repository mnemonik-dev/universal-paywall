/**
 * Extension E2E on anvil — the real payer loop through the extension core.
 *
 * Drives a REAL PayerAgent (built with an INJECTED account — exercising the
 * signer abstraction the extension requires) through the extension's message
 * handler + bridge, against a REAL x402 resource (resource-adapter):
 *
 *   bridge.upFetch(url) -> handler 'up:fetch' -> agent.fetchWithPaywall
 *     -> 402 -> auto create-vault + deposit + grant -> retry -> 200 served
 *     -> adapter meters -> facilitator settles -> creator paid on-chain
 *
 * This is the headless equivalent of the browser extension auto-paying a paywall
 * (minus the Chromium shell). Prereq: anvil on :8545; packages built.
 * Run from repo root: node packages/extension/e2e-anvil.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { withStakePaywall } from '@universal-paywall/resource-adapter';
import { createMessageHandler } from './src/handler.js';
import { createBridge } from './src/bridge.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FACILITATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const CREATOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const PRICE = 50_000n;
const CAP = 1_000_000n;

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function send(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('  ok:', m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mockUsdc = art('MockUSDC.sol/MockUSDC.json');
  const factoryArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const payerAccount = privateKeyToAccount(PAYER_KEY); // injected into the agent (no raw key)
  const facilitator = privateKeyToAccount(FACILITATOR_KEY).address;

  console.log('Deploy rail + mint USDC to payer (no vault/grant yet)...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await send(DEPLOYER, usdc, mockUsdc.abi, 'mint', [payerAccount.address, 2_000_000n]);

  console.log('Start facilitator (8402) + x402 resource (3000)...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FACILITATOR_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const resourceServer = createServer(withStakePaywall(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ paid: true })); },
    { price: PRICE, creator: CREATOR, recommendedCap: CAP, chain: { rpcUrl: RPC, chainId: CHAIN_ID, network: 'eip155:31337', asset: usdc, facilitatorAddress: facilitator, stakeVaultFactory: factory }, facilitator: { url: 'http://127.0.0.1:8402', apiKey: 'k' } },
  ));
  await new Promise((r) => resourceServer.listen(3000, () => r(null)));

  console.log('Build the agent with an INJECTED account; wire the extension handler...');
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, account: payerAccount, stakeVaultFactory: factory, usdc });
  const handle = createMessageHandler({ agent });
  const bridge = createBridge((m) => handle(m, null)); // background message channel

  console.log('Extension up:status...');
  const st = await handle({ type: 'up:status' });
  assert(st.ok && st.payer.toLowerCase() === payerAccount.address.toLowerCase(), 'up:status returns the injected-account payer');

  console.log('Extension up:fetch auto-pays the x402 resource...');
  const res = await bridge.upFetch('http://127.0.0.1:3000/paid');
  assert(res.status === 200, `extension auto-paid -> 200 (got ${res.status})`);
  const body = await res.json();
  assert(body.paid === true, 'resource body returned through the extension bridge');

  const vault = await agent.vaultAddress();
  assert(vault.toLowerCase() !== '0x0000000000000000000000000000000000000000', 'agent auto-deployed its vault during up:fetch');

  for (let i = 0; i < 50 && fac.ledger.size() === 0; i++) await sleep(20);
  assert(fac.ledger.size() === 1, 'facilitator received the metered charge');
  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled on-chain');
  const creatorBal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [CREATOR] });
  assert(creatorBal === PRICE, `creator paid ${PRICE} on-chain (got ${creatorBal})`);

  resourceServer.close();
  fac.server.close();
  console.log('\nEXTENSION E2E PASS: bridge.upFetch -> handler -> agent(injected account) -> 402->grant->200 -> on-chain settle -> creator paid');
  process.exit(0);
}
main().catch((e) => { console.error('E2E ERROR:', e); process.exit(1); });
