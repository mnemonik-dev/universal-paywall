/**
 * Jellyfin REAL L3+L4 — live instance + the OFFICIAL webhook plugin, on-chain settle.
 *
 * Jellyfin's first-party Webhook plugin POSTs playback notifications to our
 * /jellyfin route (no fork change). This script authenticates, configures the
 * plugin's Generic destination at our sidecar, reports a real playback start/stop
 * (PlaystateController -> ISessionManager.PlaybackStopped -> the plugin fires), and
 * asserts the creator is paid per minute on-chain.
 *
 * Proven 2026-06-21 (Jellyfin 10.11.11 + Webhook 21.0.0.0): the plugin's real
 * PlaybackStop payload matched the route exactly - NotificationType, UserId,
 * ItemId, PlaybackPositionTicks (SendAllProperties=true) - 2 min -> 2000 settled.
 *
 * PREREQUISITES (acceptance harness; needs Docker):
 *   1. dockerd (root):  nohup dockerd >/tmp/dockerd.log 2>&1 &
 *   2. anvil on :8545:  anvil --chain-id 31337 --port 8545 --silent &
 *   3. contracts + packages built (see HANDOFF bootstrap).
 *   4. A configured Jellyfin (host net) with a Movie library + the Webhook plugin:
 *
 *     # media (2-min movie)
 *     mkdir -p "/tmp/jf/movies/Test Movie (2020)"
 *     docker run --rm --entrypoint ffmpeg -v /tmp/jf:/out owncast/owncast:latest \
 *       -f lavfi -i "testsrc=size=320x240:rate=15:duration=120" -f lavfi -i "sine=frequency=440:duration=120" \
 *       -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest \
 *       "/out/movies/Test Movie (2020)/Test Movie (2020).mp4"
 *     # server (GHCR avoids Docker Hub anon pull limit)
 *     docker run -d --name jellyfin-l3 --network host -v /tmp/jf:/media ghcr.io/jellyfin/jellyfin:latest
 *     # wizard
 *     J=http://localhost:8096
 *     curl -s -XPOST $J/Startup/Configuration -H 'content-type: application/json' -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
 *     curl -s -XPOST $J/Startup/User -H 'content-type: application/json' -d '{"Name":"admin","Password":"abc123"}'
 *     curl -s -XPOST $J/Startup/RemoteAccess -H 'content-type: application/json' -d '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}'
 *     curl -s -XPOST $J/Startup/Complete
 *     TOKEN=$(curl -s -XPOST $J/Users/AuthenticateByName -H 'content-type: application/json' \
 *       -H 'X-Emby-Authorization: MediaBrowser Client="l3", Device="l3", DeviceId="l3dev", Version="1.0"' \
 *       -d '{"Username":"admin","Pw":"abc123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessToken"])')
 *     curl -s -XPOST "$J/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=true" \
 *       -H "X-Emby-Token: $TOKEN" -H 'content-type: application/json' -d '{"LibraryOptions":{"PathInfos":[{"Path":"/media/movies"}]}}'
 *     # webhook plugin: catalog may be empty on a fresh server -> install the zip manually
 *     curl -sL -o /tmp/webhook.zip https://repo.jellyfin.org/files/plugin/webhook/webhook_21.0.0.0.zip
 *     python3 -c 'import zipfile;zipfile.ZipFile("/tmp/webhook.zip").extractall("/tmp/wh")'
 *     docker exec jellyfin-l3 mkdir -p /config/plugins/Webhook && docker cp /tmp/wh/. jellyfin-l3:/config/plugins/Webhook/
 *     docker restart jellyfin-l3
 *   Then run from the repo root:  node packages/integrations/scripts/e2e-jellyfin-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFacilitator } from '@universal-paywall/facilitator';
import { createPayerAgent } from '@universal-paywall/agent';
import { createReporter, createSidecarServer, mapResolver, jellyfinRoute } from '../dist/index.js';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const J = 'http://localhost:8096';
const WEBHOOK_GUID = '71552a5a5c5c4350a2aeebe451a30173';
const RATE = 1000n; // micro-USDC per minute
const POSITION_TICKS = 1_200_000_000; // 120s -> 2 minutes (TICKS_PER_MINUTE = 600,000,000)
// Public anvil dev keys (accounts #0-#2). Local-only, zero-value, not secrets.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // gitleaks:allow
const FAC_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // gitleaks:allow
const STREAMER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const art = (p) => { const a = JSON.parse(readFileSync(join(root, 'contracts/out', p), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; };
async function deploy(k, a, args) { const acc = privateKeyToAccount(k); const w = createWalletClient({ account: acc, chain, transport: http(RPC) }); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: acc, chain }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function sendTx(k, address, abi, fn, args) { const acc = privateKeyToAccount(k); const w = createWalletClient({ account: acc, chain, transport: http(RPC) }); const h = await w.writeContract({ address, abi, functionName: fn, args, account: acc, chain }); await pub.waitForTransactionReceipt({ hash: h }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfAuth() {
  const res = await fetch(`${J}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="l3", Device="l3", DeviceId="l3dev", Version="1.0"' },
    body: JSON.stringify({ Username: 'admin', Pw: 'abc123' }),
  });
  const j = await res.json();
  return { token: j.AccessToken, userId: j.User.Id };
}

async function main() {
  const usdcArt = art('MockUSDC.sol/MockUSDC.json'), facArt = art('StakeVaultFactory.sol/StakeVaultFactory.json');
  const viewer = privateKeyToAccount(PAYER_KEY).address, facAddr = privateKeyToAccount(FAC_KEY).address;

  console.log('1. Authenticate to Jellyfin + find the movie...');
  const { token, userId } = await jfAuth();
  const H = { 'content-type': 'application/json', 'X-Emby-Token': token };
  const items = await (await fetch(`${J}/Items?Recursive=true&IncludeItemTypes=Movie&userId=${userId}`, { headers: H })).json();
  const itemId = items.Items?.[0]?.Id;
  if (!itemId) throw new Error('no movie found - configure the library first');
  console.log('   userId', userId, '| itemId', itemId);

  console.log('2. Point the Webhook plugin at our sidecar (PlaybackStop, SendAllProperties)...');
  await fetch(`${J}/Plugins/${WEBHOOK_GUID}/Configuration`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      ServerUrl: J,
      GenericOptions: [{ WebhookName: 'up', WebhookUri: 'http://localhost:8410/jellyfin', NotificationTypes: ['PlaybackStop'], EnableMovies: true, EnableVideos: true, SendAllProperties: true, EnableWebhook: true, Headers: [], Fields: [], UserFilter: [], Template: '' }],
      DiscordOptions: [], GenericFormOptions: [], GotifyOptions: [], PushbulletOptions: [], PushoverOptions: [], SlackOptions: [], SmtpOptions: [],
    }),
  });

  console.log('3. Deploy rail + grant...');
  const usdc = await deploy(DEPLOYER, usdcArt, []); const factory = await deploy(DEPLOYER, facArt, [usdc]);
  await sendTx(DEPLOYER, usdc, usdcArt.abi, 'mint', [viewer, 2_000_000n]);
  const agent = createPayerAgent({ rpcUrl: RPC, chainId: CHAIN_ID, payerKey: PAYER_KEY, stakeVaultFactory: factory, usdc });
  await agent.ensureGrant({ facilitator: facAddr, stakeVaultFactory: factory, recommendedCap: 1_000_000n, validForSeconds: 3600 });

  console.log('4. Facilitator + REAL sidecar (jellyfinRoute)...');
  const fac = createFacilitator({ rpcUrl: RPC, chainId: CHAIN_ID, facilitatorKey: FAC_KEY, stakeVaultFactory: factory, apiKeys: ['k'], batch: { maxCharges: 100, maxAgeMs: 1 } });
  await new Promise((r) => fac.server.listen(8402, () => r(null)));
  const reporter = createReporter({ facilitatorUrl: 'http://127.0.0.1:8402', apiKey: 'k', resolvePayer: mapResolver({ [userId]: viewer }), resolveCreator: mapResolver({ [itemId]: STREAMER }) });
  let charged = null;
  const base = jellyfinRoute(reporter, { ratePerMinute: RATE });
  const sidecar = createSidecarServer([{ ...base, handle: async (ctx) => { console.log('   >>> REAL WEBHOOK BYTES:', JSON.stringify(ctx.body)); const o = await base.handle(ctx); if (o && o.status === 'charged') charged = o; return o; } }]);
  await new Promise((r) => sidecar.listen(8410, () => r(null)));

  console.log('5. Report a real playback start + stop (PositionTicks', POSITION_TICKS, ')...');
  const ps = 'l3-play-session';
  await fetch(`${J}/Sessions/Playing`, { method: 'POST', headers: H, body: JSON.stringify({ ItemId: itemId, PlaySessionId: ps, CanSeek: true, PositionTicks: 0, PlayMethod: 'DirectPlay' }) });
  await sleep(1000);
  await fetch(`${J}/Sessions/Playing/Stopped`, { method: 'POST', headers: H, body: JSON.stringify({ ItemId: itemId, PlaySessionId: ps, PositionTicks: POSITION_TICKS }) });

  console.log('6. Wait for the plugin PlaybackStop webhook -> charge...');
  for (let i = 0; i < 25 && charged === null; i++) await sleep(1000);
  if (charged === null) throw new Error('no charge from PlaybackStop webhook');
  console.log('   CHARGE:', JSON.stringify(charged, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  const results = await fac.service.flushAll();
  const bal = await pub.readContract({ address: usdc, abi: usdcArt.abi, functionName: 'balanceOf', args: [STREAMER] });
  if (!(results.length === 1 && results[0].ok)) throw new Error('no settle');
  if (bal <= 0n) throw new Error('creator not paid');
  sidecar.close();
  fac.server.close();
  console.log(`\nREAL JELLYFIN L3 PASS: PlaybackStop (official webhook plugin) -> sidecar -> facilitator -> on-chain settle -> creator paid ${bal} micro-USDC`);
  process.exit(0);
}
main().catch((e) => { console.error('L3 ERROR:', e); process.exit(1); });
