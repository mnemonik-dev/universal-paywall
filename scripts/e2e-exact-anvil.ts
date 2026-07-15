/**
 * Deploy MockUsdcEip3009 + SessionStakeVaultFactory on a local anvil chain
 * and fund a test payer for exact x402 end-to-end tests.
 *
 * Run after `anvil --port 8545 --chain-id 31337` is running.
 * Outputs JSON to stdout with contract addresses and recommended env vars.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env['ARC_RPC_URL'] ?? 'http://127.0.0.1:8545';
const CHAIN_ID = Number(process.env['CHAIN_ID'] ?? '31337');

// Anvil dev accounts #0 (deployer) and #1 (payer). Public test keys.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const PAYEE = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function artifact(path: string) {
  const a = JSON.parse(readFileSync(join(root, 'contracts/out', path), 'utf8')) as {
    abi: unknown;
    bytecode: { object: `0x${string}` };
  };
  return { abi: a.abi, bytecode: a.bytecode.object };
}

const pub = createPublicClient({ chain, transport: http(RPC) });

async function deploy(walletKey: `0x${string}`, art: ReturnType<typeof artifact>, args: unknown[]) {
  const account = privateKeyToAccount(walletKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await wallet.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    args,
    account,
    chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('no contract address');
  return receipt.contractAddress;
}

async function send(
  walletKey: `0x${string}`,
  address: `0x${string}`,
  abi: unknown,
  functionName: string,
  args: unknown[],
) {
  const account = privateKeyToAccount(walletKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain });
  await pub.waitForTransactionReceipt({ hash });
}

async function main() {
  const usdcArt = artifact('MockUsdcEip3009.sol/MockUsdcEip3009.json');
  const factoryArt = artifact('SessionStakeVaultFactory.sol/SessionStakeVaultFactory.json');

  const payer = privateKeyToAccount(PAYER_KEY).address;

  const usdc = await deploy(DEPLOYER, usdcArt, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);

  // Fund payer with 100 USDC (6 decimals).
  await send(DEPLOYER, usdc, usdcArt.abi, 'mint', [payer, 100_000_000n]);

  const result = {
    rpc_url: RPC,
    chain_id: CHAIN_ID,
    usdc_address: usdc,
    session_stake_vault_factory: factory,
    payer_address: payer,
    payer_private_key: PAYER_KEY,
    payee_address: PAYEE,
    eip712_name: 'USD Coin',
    eip712_version: '2',
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error('DEPLOY ERROR:', e);
  process.exit(1);
});
