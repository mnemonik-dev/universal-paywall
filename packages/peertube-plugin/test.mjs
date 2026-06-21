// Standalone test for peertube-plugin-universal-paywall.
// Drives register() with mock PeerTube APIs, fires the view hook, and asserts the
// resulting charge reaches a mock facilitator with the resolved wallets/amount.
// Run: node test.mjs   (requires @universal-paywall/integrations built)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('./main.js');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed++;
  console.log('  ok:', msg);
}

async function main() {
  // Mock facilitator: records POST /charge bodies.
  const charges = [];
  const fac = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/charge') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        charges.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'ack-1', status: 'queued' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fac.listen(0, r));
  const port = fac.address().port;

  const PAYER = '0x1111111111111111111111111111111111111111';
  const CREATOR = '0x2222222222222222222222222222222222222222';
  const config = {
    'facilitator-url': `http://127.0.0.1:${port}`,
    'facilitator-api-key': 'k',
    'price-micro-usdc': '2000',
    'viewer-wallets': JSON.stringify({ alice: PAYER }),
    'channel-wallets': JSON.stringify({ chan1: CREATOR }),
  };

  // Mock PeerTube register API.
  const registeredSettings = [];
  let viewHook = null;
  await plugin.register({
    registerSetting: (s) => registeredSettings.push(s.name),
    settingsManager: { getSetting: async (k) => config[k] },
    registerHook: ({ target, handler }) => {
      if (target === 'action:api.video.viewed') viewHook = handler;
    },
  });

  assert(registeredSettings.includes('facilitator-url'), 'register() registered the settings');
  assert(typeof viewHook === 'function', 'register() registered the action:api.video.viewed hook');

  // Fire a view with a known payer header.
  await viewHook({ video: { channelId: 'chan1', uuid: 'vid-uuid-1' }, req: { headers: { 'x-payer-user': 'alice' } } });
  assert(charges.length === 1, 'a view produced exactly one charge');
  assert(charges[0].payer === PAYER, `payer resolved to the viewer wallet (got ${charges[0].payer})`);
  assert(charges[0].creator === CREATOR, `creator resolved to the channel wallet (got ${charges[0].creator})`);
  assert(charges[0].amount === '2000', `amount is the configured price (got ${charges[0].amount})`);
  assert(String(charges[0].ref).startsWith('peertube:vid-uuid-1:'), 'ref is per-view (peertube:<uuid>:<ts>)');

  // Unknown payer (anonymous) is metered-and-skipped (no charge).
  await viewHook({ video: { channelId: 'chan1', uuid: 'vid-uuid-2' }, req: { headers: {} } });
  assert(charges.length === 1, 'anonymous view (unresolved payer) produced no charge');

  // Not configured -> no charge, no throw.
  let viewHook2 = null;
  await plugin.register({
    registerSetting: () => {},
    settingsManager: { getSetting: async () => '' },
    registerHook: ({ target, handler }) => { if (target === 'action:api.video.viewed') viewHook2 = handler; },
  });
  await viewHook2({ video: { channelId: 'chan1', uuid: 'v3' }, req: { headers: { 'x-payer-user': 'alice' } } });
  assert(charges.length === 1, 'unconfigured plugin makes no charge');

  fac.close();
  console.log(`\nPEERTUBE PLUGIN TEST PASS (${passed} assertions)`);
  process.exit(0);
}
main().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
