/**
 * Agent-driven full loop on anvil. The agent helper does everything itself:
 *
 *   agent.fetchWithPaywall(url)
 *     → sends a signed proof → 402 (no grant)
 *     → ensureGrant: createVault + deposit + grantPolicy on-chain
 *     → retries with a fresh proof → 200 served
 *   → adapter reports usage → facilitator settles → creator paid on-chain
 *
 * Prereq: anvil on http://127.0.0.1:8545 (chain 31337); agent + facilitator +
 * resource-adapter built. Run: npx tsx packages/agent/scripts/e2e-agent-anvil.ts
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { withStakePaywall } from '@universal-paywall/resource-adapter';
import { createPayerAgent } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
// Public anvil dev keys (accounts #0–#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FACILITATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const CREATOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mockUsdc = artifact('MockUSDC.sol/MockUSDC.json');
  const factoryArt = artifact('StakeVaultFactory.sol/StakeVaultFactory.json');
  const payer = privateKeyToAccount(PAYER_KEY).address;
  const facilitator = privateKeyToAccount(FACILITATOR_KEY).address;
  const PRICE = 50_000n;
  const CAP = 1_000_000n;

  console.log('Deploy rail + mint USDC to payer (no vault/grant yet)...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await send(DEPLOYER, usdc, mockUsdc.abi, 'mint', [payer, 2_000_000n]);

  console.log('Start facilitator (8402) + resource server (3000)...');
  const fac = createFacilitator({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    facilitatorKey: FACILITATOR_KEY,
    stakeVaultFactory: factory,
    apiKeys: ['k'],
    batch: { maxCharges: 100, maxAgeMs: 1 },
  });
  await new Promise((res) => fac.server.listen(8402, () => res(null)));

  const resourceServer = createServer(
    withStakePaywall(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ paid: true }));
      },
      {
        price: PRICE,
        creator: CREATOR,
        recommendedCap: CAP,
        chain: {
          rpcUrl: RPC,
          chainId: CHAIN_ID,
          network: 'eip155:31337',
          asset: usdc,
          facilitatorAddress: facilitator,
          stakeVaultFactory: factory,
        },
        facilitator: { url: 'http://127.0.0.1:8402', apiKey: 'k' },
      },
    ),
  );
  await new Promise((res) => resourceServer.listen(3000, () => res(null)));

  console.log('Agent: fetchWithPaywall (auto create-vault + deposit + grant + retry)...');
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  const response = await agent.fetchWithPaywall('http://127.0.0.1:3000/paid');
  assert(response.status === 200, `agent auto-paid and got 200 (got ${response.status})`);
  const body = await response.json();
  assert(body.paid === true, 'resource body served to the agent');

  // grant landed on-chain
  const vault = await agent.vaultAddress();
  assert(vault.toLowerCase() !== '0x0000000000000000000000000000000000000000', 'agent deployed its vault');

  for (let i = 0; i < 50 && fac.ledger.size() === 0; i++) await sleep(20);
  assert(fac.ledger.size() === 1, 'facilitator received the metered charge');
  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled the charge on-chain');

  const creatorBal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [CREATOR] });
  assert(creatorBal === PRICE, `creator paid ${PRICE} on-chain (got ${creatorBal})`);

  resourceServer.close();
  fac.server.close();
  console.log('\nAGENT E2E PASS: agent auto-funded+granted → 200 → charge → on-chain settle');
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
