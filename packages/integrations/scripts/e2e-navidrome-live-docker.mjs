/**
 * Navidrome REAL L3+L4 — live instance, native scrobble, MusicBrainz resolve, settle.
 *
 * Navidrome scrobbles natively to any ListenBrainz-compatible server set via
 * ND_LISTENBRAINZ_BASEURL. Pointing it at our sidecar attaches per-listen royalties
 * with ZERO changes to Navidrome. This drives a REAL Navidrome container: links a
 * ListenBrainz token (-> our /1/validate-token), scrobbles a real (MBID-tagged)
 * track via the Subsonic API, and asserts the artist is paid on-chain - resolving
 * recording_mbid -> artist via the live MusicBrainz WS/2 resolver.
 *
 * Proven 2026-06-21: real Navidrome scrobble payload matched the sidecar parser
 * (listen_type=single, recording_mbid=f1aa509e..., artist_mbids=[4d5447d7...]);
 * recording -> John Lennon -> wallet -> 100 micro-USDC settled on-chain.
 *
 * PREREQUISITES (acceptance harness, needs Docker + network egress to WS/2):
 *   1. dockerd running (root):  nohup dockerd >/tmp/dockerd.log 2>&1 &
 *   2. anvil on :8545:          anvil --chain-id 31337 --port 8545 --silent &
 *   3. contracts + packages built (see HANDOFF bootstrap).
 *   4. A tagged track + a live Navidrome (host net so it reaches the host sidecar):
 *        mkdir -p /tmp/l3-music
 *        docker run --rm --entrypoint ffmpeg -v /tmp/l3-music:/out ghcr.io/navidrome/navidrome:latest \
 *          -f lavfi -i "sine=frequency=440:duration=3" -metadata title="Imagine Basic Track" \
 *          -metadata artist="John Lennon" -metadata album="Imagine" \
 *          -metadata MUSICBRAINZ_TRACKID="f1aa509e-7cda-4e0e-b59b-f6ccfb53783c" \
 *          -id3v2_version 3 /out/imagine.mp3
 *        docker run -d --name navidrome-l3 --network host -e ND_MUSICFOLDER=/music \
 *          -e ND_DEVAUTOCREATEADMINPASSWORD=abc123 -e ND_LISTENBRAINZ_ENABLED=true \
 *          -e ND_LISTENBRAINZ_BASEURL=http://localhost:8410/1/ -e ND_SCANSCHEDULE=0 \
 *          -v /tmp/l3-music:/music ghcr.io/navidrome/navidrome:latest
 *        # then trigger a scan: curl 'http://localhost:4533/rest/startScan.view?u=admin&p=abc123&v=1.16.1&c=l3&f=json'
 * Run from the repo root:  node packages/integrations/scripts/e2e-navidrome-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, createSidecarServer, createMusicBrainzResolver, mapResolver, listenBrainzRoutes } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const NAV = 'http://localhost:4533';
const RATE = 100n; // micro-USDC per listen
const LB_TOKEN = 'viewer-lb-token';
const ARTIST_MBID = '4d5447d7-c61c-4120-ba1b-d7f471d385b9'; // John Lennon
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const acc = privateKeyToAccount(k); const w = createWalletClient({ account: acc, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: acc, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function sendTx(k, address, abi, fn, args) { const acc = privateKeyToAccount(k); const w = createWalletClient({ account: acc, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: acc, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SA = 'u=admin&p=abc123&v=1.16.1&c=l3&f=json';

async function main() {
  const mockUsdc = art('MockUSDC.sol/MockUSDC.json'), factoryArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. Deploy rail + grant...');
  const usdc = await deploy(DEPLOYER, mockUsdc, []);
  const factory = await deploy(DEPLOYER, factoryArt, [usdc]);
  await sendTx(DEPLOYER, usdc, mockUsdc.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });

  console.log('2. Start facilitator + REAL sidecar (ListenBrainz target + MusicBrainz resolver)...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const reporter = createReporter({
    facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k',
    resolvePayer: mapResolver({ [LB_TOKEN]: viewer }),
    resolveCreator: createMusicBrainzResolver({ walletRegistry: mapResolver({ [ARTIST_MBID]: STREAMER }), userAgent: 'universal-paywall-l3/0.1 (ops@example.com)', minIntervalMs: 1000 }),
  });
  let charged = null;
  const baseReport = reporter.report.bind(reporter);
  reporter.report = async (i) => { const o = await baseReport(i); if (o.status === 'charged') charged = o; return o; };
  const routes = listenBrainzRoutes(reporter, { ratePerListen: RATE }).map((rt) => rt.path.endsWith('submit-listens')
    ? { ...rt, handle: async (ctx) => { console.log('   >>> REAL SCROBBLE BYTES:', JSON.stringify(ctx.body)); return rt.handle(ctx); } } : rt);
  const sidecar = createSidecarServer(routes);
  await new Promise((r) => sidecar.listen(8410, () => r(null)));

  console.log('3. Login to Navidrome -> JWT...');
  const login = await (await fetch(`${NAV}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'abc123' }) })).json();
  if (!login.token) throw new Error('no jwt: ' + JSON.stringify(login));

  console.log('4. Link ListenBrainz (token -> our /1/validate-token)...');
  const link = await fetch(`${NAV}/api/listenbrainz/link?jwt=${login.token}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: LB_TOKEN }) });
  console.log('   link status', link.status, await link.text());

  console.log('5. Find the MBID-tagged song + scrobble it (submission=true)...');
  const sr = await (await fetch(`${NAV}/rest/search3.view?${SA}&query=Imagine`)).json();
  const song = sr['subsonic-response'].searchResult3.song?.[0];
  if (!song) throw new Error('song not found - scan the library first');
  console.log('   song', song.id, '| recMBID', song.musicBrainzId);
  await fetch(`${NAV}/rest/scrobble.view?${SA}&id=${song.id}&submission=true&time=${Date.now()}`);

  console.log('6. Wait for the forwarded scrobble -> charge...');
  for (let i = 0; i < 25 && charged === null; i++) await sleep(1000);
  if (charged === null) throw new Error('no charge from real scrobble within timeout');
  console.log('   CHARGE:', JSON.stringify(charged, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  console.log('7. Flush + assert on-chain settle...');
  const results = await fac.service.flushAll();
  const bal = await pub.readContract({ address: usdc, abi: mockUsdc.abi, functionName: 'balanceOf', args: [STREAMER] });
  if (!(results.length === 1 && results[0].ok)) throw new Error('no settle');
  if (bal <= 0n) throw new Error('artist not paid');
  sidecar.close();
  fac.server.close();
  console.log(`\nREAL NAVIDROME L3 PASS: scrobble -> ListenBrainz target -> recording_mbid -> MusicBrainz artist -> facilitator -> on-chain settle -> artist paid ${bal} micro-USDC`);
  process.exit(0);
}
main().catch((e) => { console.error('L3 ERROR:', e); process.exit(1); });
