/**
 * Full-loop integration on anvil: proves the resource-server adapter wires the
 * whole rail together.
 *
 *   deploy + grant  →  agent hits resource WITHOUT proof  → 402 payer_required
 *                   →  agent signs proof + hits again      → 200 served
 *                   →  adapter reports usage to facilitator → facilitator settles
 *                   →  assert creator was paid on-chain
 *
 * Prereq: anvil on http://127.0.0.1:8545 (chain 31337); facilitator + adapter
 * built (`npm run build` in each).
 *
 * Run: npx tsx packages/resource-adapter/scripts/e2e-adapter-anvil.ts
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { withStakePaywall } from '../dist/index.js';

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
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress;
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
  const vaultArt = artifact('StakeVault.sol/StakeVault.json');

  const payerAccount = privateKeyToAccount(PAYER_KEY);
  const payer = payerAccount.address;
  const facilitator = privateKeyToAccount(FACILITATOR_KEY).address;
  const PRICE = 50_000n;

  console.log('Deploy + vault + grant...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await send(DEPLOYER, factory, factoryArt.abi, 'createVault', [payer]);
  const vault = await pub.readContract({ address: factory, abi: factoryArt.abi, functionName: 'vaults', args: [payer] });
  await send(DEPLOYER, usdc, mockUsdc.abi, 'mint', [payer, 1_000_000n]);
  await send(PAYER_KEY, usdc, mockUsdc.abi, 'approve', [vault, 1_000_000n]);
  await send(PAYER_KEY, vault, vaultArt.abi, 'deposit', [1_000_000n]);
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await send(PAYER_KEY, vault, vaultArt.abi, 'grantPolicy', [facilitator, 600_000n, validUntil]);

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

  // 1) No proof → 402 payer_required
  const r402 = await fetch('http://127.0.0.1:3000/paid');
  const b402 = await r402.json();
  assert(r402.status === 402 && b402.error === 'payer_required', '402 payer_required without proof');

  // 2) Signed proof + active grant → 200
  const ts = Math.floor(Date.now() / 1000);
  const message = `universal-paywall:${payer.toLowerCase()}:${ts}`;
  const signature = await payerAccount.signMessage({ message });
  const r200 = await fetch('http://127.0.0.1:3000/paid', {
    headers: { 'x-payer': payer, 'x-payer-timestamp': String(ts), 'x-payer-signature': signature },
  });
  assert(r200.status === 200, 'resource served (200) with valid proof + grant');

  // 3) Wait for the adapter's post-serve charge to land, then settle.
  for (let i = 0; i < 50 && fac.ledger.size() === 0; i++) await sleep(20);
  assert(fac.ledger.size() === 1, 'facilitator received the metered charge');
  const results = await fac.service.flushAll();
  assert(results.length === 1 && results[0].ok, 'facilitator settled the charge on-chain');

  const creatorBal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [CREATOR] });
  assert(creatorBal === PRICE, `creator paid ${PRICE} on-chain (got ${creatorBal})`);

  resourceServer.close();
  fac.server.close();
  console.log('\nADAPTER E2E PASS: 402 → proof+grant → 200 served → charge → on-chain settle');
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
