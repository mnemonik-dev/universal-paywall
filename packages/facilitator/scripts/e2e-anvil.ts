/**
 * End-to-end proof on a local anvil chain. Exercises the REAL on-chain settler
 * and viem path:
 *   deploy MockUSDC + StakeVaultFactory → createVault(payer) → payer deposits +
 *   grants a policy → creator charges via the facilitator service → facilitator
 *   batches + settles on-chain → assert creator paid and payer stake debited.
 *
 * Prereq: anvil running on http://127.0.0.1:8545 (chain id 31337) and the
 * facilitator package built (`npm run build --workspace=@universal-paywall/facilitator`).
 *
 * Run: npx tsx packages/facilitator/scripts/e2e-anvil.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;

// Well-known, public anvil dev keys (accounts #0–#2). Deterministic, zero-value,
// documented in every Foundry repo — used ONLY against a local anvil. Not secrets.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
function artifact(path) {
  const a = JSON.parse(readFileSync(join(root, 'contracts/out', path), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

const pub = createPublicClient({ chain, transport: http(RPC) });

async function deploy(walletKey, art, args) {
  const account = privateKeyToAccount(walletKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('no contract address');
  return receipt.contractAddress;
}

async function send(walletKey, address, abi, functionName, args) {
  const account = privateKeyToAccount(walletKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain });
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
  const vaultArt = artifact('StakeVault.sol/StakeVault.json');

  const payer = privateKeyToAccount(PAYER_KEY).address;
  const facilitator = privateKeyToAccount(FACILITATOR_KEY).address;

  console.log('Deploying MockUSDC + StakeVaultFactory...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);

  console.log('createVault(payer)...');
  await send(DEPLOYER, factory, factoryArt.abi, 'createVault', [payer]);
  const vault = await pub.readContract({ address: factory, abi: factoryArt.abi, functionName: 'vaults', args: [payer] });

  const STAKE = 1_000_000n;
  const CAP = 600_000n;
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log('Fund + grant...');
  await send(DEPLOYER, usdc, mockUsdc.abi, 'mint', [payer, STAKE]);
  await send(PAYER_KEY, usdc, mockUsdc.abi, 'approve', [vault, STAKE]);
  await send(PAYER_KEY, vault, vaultArt.abi, 'deposit', [STAKE]);
  await send(PAYER_KEY, vault, vaultArt.abi, 'grantPolicy', [facilitator, CAP, validUntil]);

  console.log('Charging via facilitator service (real OnChainSettler)...');
  const { service } = createFacilitator({
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    facilitatorKey: FACILITATOR_KEY,
    stakeVaultFactory: factory,
    apiKeys: ['k'],
    batch: { maxCharges: 100, maxAgeMs: 1 },
  });

  service.charge({ payer, creator: CREATOR, amount: 100_000n });
  service.charge({ payer, creator: CREATOR, amount: 50_000n });
  const results = await service.flushAll();
  assert(results.length === 1 && results[0].ok, 'batched settlement succeeded on-chain');

  const creatorBal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [CREATOR] });
  assert(creatorBal === 150_000n, `creator received aggregated 150000 (got ${creatorBal})`);

  const policy = await pub.readContract({ address: vault, abi: vaultArt.abi, functionName: 'policy' });
  assert(policy[2] === 150_000n, `vault spent == 150000 (got ${policy[2]})`);

  const withdrawable = await pub.readContract({ address: vault, abi: vaultArt.abi, functionName: 'withdrawable' });
  assert(withdrawable === STAKE - CAP, `payer withdrawable == ${STAKE - CAP} (got ${withdrawable})`);

  console.log('\nE2E PASS: deposit → grant → charge → batched on-chain settle → balances correct');
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
