/**
 * Subsonic REAL L3+L4 — live Subsonic server (gonic) + reverse-proxy -> settle.
 *
 * Puts `createSubsonicProxy` in front of a real Subsonic server; a real scrobble
 * (`GET /rest/scrobble.view?...&id=…&submission=true`) is proxied to the server
 * (which records the play) AND metered as a per-listen royalty. No server edit.
 * Covers the Subsonic family / the proxy mechanism (Navidrome uses the cleaner
 * ListenBrainz config-redirect; see e2e-navidrome-live-docker.mjs).
 *
 * Proven 2026-06-22: live gonic 0.22.0, real scrobble of a scanned track via the
 * proxy -> artist paid 100 micro-USDC on-chain.
 *
 * PREREQUISITES (acceptance harness; needs Docker):
 *   1. dockerd (root); 2. anvil :8545; 3. contracts + packages built.
 *   4. A live gonic (host net) with a scanned library:
 *        # one tagged mp3 under /tmp/gonic-music/<Artist>/<Album>/song.mp3
 *        docker run -d --name gonic-l3 --network host \
 *          -e GONIC_MUSIC_PATH=/music -e GONIC_PODCAST_PATH=/data/podcasts \
 *          -e GONIC_PLAYLISTS_PATH=/data/playlists -e GONIC_CACHE_PATH=/cache \
 *          -e GONIC_DB_PATH=/data/gonic.db -e GONIC_LISTEN_ADDR=0.0.0.0:4747 \
 *          -v /tmp/gonic-music:/music -v /tmp/gonic-data:/data sentriz/gonic
 *        curl 'http://localhost:4747/rest/startScan.view?u=admin&p=admin&v=1.16.1&c=l3&f=json'
 *        # write the scanned track id (search3) to /tmp/gonic_song
 * Run from repo root: node packages/integrations/scripts/e2e-subsonic-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, mapResolver, createSubsonicProxy } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const GONIC = 'http://localhost:4747';
const RATE = 100n;
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const ARTIST_WALLET = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: ac, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function txw(k, address, abi, fn, args) { const ac = privateKeyToAccount(k); const w = createWalletClient({ account: ac, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: ac, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const song = readFileSync('/tmp/gonic_song', 'utf8').trim();
  const usdcArt = art('MockUSDC.sol/MockUSDC.json'), facArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. rail + grant + facilitator...');
  const usdc = await deploy(DEPLOYER, usdcArt, []); const factory = await deploy(DEPLOYER, facArt, [usdc]);
  await txw(DEPLOYER, usdc, usdcArt.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));

  console.log('2. Subsonic reverse-proxy in front of gonic (track', song, '-> wallet)...');
  const reporter = createReporter({ facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k', resolvePayer: mapResolver({ admin: viewer }), resolveCreator: mapResolver({ [song]: ARTIST_WALLET }) });
  const proxy = createServer(createSubsonicProxy({ upstreamUrl: GONIC, reporter, ratePerPlay: RATE }));
  await new Promise((r) => proxy.listen(8410, () => r(null)));

  console.log('3. real scrobble THROUGH the proxy...');
  const res = await fetch(`http://127.0.0.1:8410/rest/scrobble.view?u=admin&p=admin&v=1.16.1&c=l3&f=json&id=${song}&submission=true&time=${Date.now()}`);
  const j = await res.json();
  if (j['subsonic-response'].status !== 'ok') throw new Error('gonic did not accept the scrobble');

  console.log('4. meter -> charge -> settle...');
  for (let i = 0; i < 15; i++) {
    await fac.service.flushAll();
    const bal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [ARTIST_WALLET] });
    if (bal > 0n) { console.log(`\nREAL SUBSONIC L3 PASS: real scrobble via reverse-proxy -> per-listen royalty -> facilitator -> on-chain settle -> artist paid ${bal} micro-USDC`); proxy.close(); fac.server.close(); process.exit(0); }
    await sleep(1000);
  }
  console.error('no charge'); proxy.close(); fac.server.close(); process.exit(1);
}
main().catch((e) => { console.error('L3 ERROR:', e); process.exit(1); });
