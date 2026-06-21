/**
 * Mastodon donation-flow L4 — provider serves the campaign; the donation settles
 * through the rail at the donation_url. Docker-free (CI-able): proves the full
 * money path the Mastodon banner leads to, with the provider serving the real
 * campaign schema (the L2 contract is field-verified separately + live).
 *
 *   Mastodon GET /api/v1/donation_campaigns -> our provider (campaign + donation_url)
 *   donor stakes + grants (agent) -> facilitator charges the donation
 *   -> StakeVault.settle -> the instance's wallet is funded on-chain
 *
 * Run: anvil on :8545, then
 *   node packages/integrations/scripts/e2e-mastodon-donation-anvil.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, createSidecarServer, mapResolver, mastodonCampaignRoute } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const PROVIDER_PORT = 8500;
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const DONOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const INSTANCE_WALLET = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'; // the Mastodon instance's payee
const DONATION = 5_000_000n; // micro-USDC (one of the campaign's one_time USD presets)

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function sendTx(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('  ok:', m); }

async function main() {
  const usdcArt = art('MockUSDC.sol/MockUSDC.json'), facArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const donor = privateKeyToAccount(DONOR_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. Deploy rail + donor stakes + grants...');
  const usdc = await deploy(DEPLOYER, usdcArt, []); const factory = await deploy(DEPLOYER, facArt, [usdc]);
  await sendTx(DEPLOYER, usdc, usdcArt.abi, 'mint', [donor, 20_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: DONOR_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 10_000_000n, validForSeconds: 3600 });

  console.log('2. Start the Mastodon donation-campaign provider...');
  const donationUrl = `https://pay.example/donate?facilitator=${facAddr}&factory=${factory}&recipient=${INSTANCE_WALLET}&amount=${DONATION}`;
  const provider = createSidecarServer([mastodonCampaignRoute({
    campaign: {
      id: 'up-instance-1',
      banner_message: 'Support this instance — settles onchain via Universal Paywall',
      banner_button_text: 'Donate',
      donation_message: 'Your contribution settles onchain, non-custodially.',
      donation_button_text: 'Contribute',
      donation_success_post: 'I just supported this instance via Universal Paywall.',
      amounts: { one_time: { USD: [1_000_000, 5_000_000, 10_000_000] }, monthly: { USD: [5_000_000] } },
      default_currency: 'USD',
      donation_url: donationUrl,
    },
  })]);
  await new Promise((r) => provider.listen(PROVIDER_PORT, () => r(null)));

  console.log('3. Mastodon fetches the campaign (real query shape)...');
  const res = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/api/v1/donation_campaigns?platform=web&seed=42&locale=en`);
  assert(res.status === 200, 'provider served the campaign (200)');
  const campaign = await res.json();
  assert(campaign.locale === 'en', 'campaign echoes the requested locale');
  assert(Array.isArray(campaign.amounts.one_time.USD), 'amounts is the real nested schema');
  const url = new URL(campaign.donation_url);
  const recipient = url.searchParams.get('recipient');
  const amount = BigInt(url.searchParams.get('amount'));
  console.log('   donation_url recipient', recipient, 'amount', amount.toString());

  console.log('4. Facilitator + the donor donates at donation_url -> settle to the instance...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const reporter = createReporter({ facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k', resolvePayer: mapResolver({ donor }), resolveCreator: mapResolver({ instance: recipient }) });
  const outcome = await reporter.report({ payerKey: 'donor', creatorKey: 'instance', amount, ref: `donation:${campaign.id}` });
  assert(outcome.status === 'charged', 'donation charged to the donor for the instance');

  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled the donation on-chain');
  const bal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [INSTANCE_WALLET] });
  assert(bal === DONATION, `instance wallet received the donation (${DONATION}, got ${bal})`);

  provider.close();
  fac.server.close();
  console.log('\nMASTODON DONATION L4 PASS: provider campaign -> donation_url -> donor stake/grant -> facilitator -> on-chain settle -> instance funded', bal.toString());
  process.exit(0);
}
main().catch((e) => { console.error('L4 ERROR:', e); process.exit(1); });
