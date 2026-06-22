// Tests the extension's core: the message handler (routing over a mock PayerAgent)
// and the bridge client. Run: node test.mjs
import { createMessageHandler } from './src/handler.js';
import { createBridge } from './src/bridge.js';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  passed++;
  console.log('  ok:', msg);
}

function mockAgent() {
  const calls = { ensureGrant: [], fetch: [] };
  return {
    calls,
    payer: '0x1111111111111111111111111111111111111111',
    async vaultAddress() { return '0x2222222222222222222222222222222222222222'; },
    async ensureGrant(req) { calls.ensureGrant.push(req); },
    async fetchWithPaywall(url, init) {
      calls.fetch.push({ url, init });
      return new Response('paid-body', { status: 200, headers: { 'x-paid': '1' } });
    },
  };
}

async function main() {
  const agent = mockAgent();
  const handle = createMessageHandler({ agent });

  // status
  const st = await handle({ type: 'up:status' });
  assert(st.ok && st.payer === agent.payer && st.vault === '0x2222222222222222222222222222222222222222', 'up:status returns payer + vault');

  // ensureGrant
  const eg = await handle({ type: 'up:ensureGrant', req: { facilitator: '0xfac', recommendedCap: 5n, validForSeconds: 60 } });
  assert(eg.ok && agent.calls.ensureGrant.length === 1, 'up:ensureGrant forwards to the agent');

  // fetch
  const f = await handle({ type: 'up:fetch', url: 'https://api.example/x402', init: { method: 'GET' } });
  assert(f.ok && f.status === 200 && f.body === 'paid-body' && f.headers['x-paid'] === '1', 'up:fetch returns the paid response (status/body/headers)');
  assert(agent.calls.fetch[0].url === 'https://api.example/x402', 'up:fetch passed the url to the agent');

  // bad / unknown
  assert((await handle({})).error === 'bad_message', 'bad message rejected');
  assert((await handle({ type: 'nope' })).error === 'unknown_type', 'unknown type rejected');
  assert((await handle({ type: 'up:fetch' })).error === 'missing_url', 'up:fetch without url rejected');

  // origin allowlist for external senders
  const handleAllow = createMessageHandler({ agent, allowList: ['trusted-ext-id'] });
  assert((await handleAllow({ type: 'up:status' }, { external: true, id: 'evil-ext' })).error === 'origin_not_allowed', 'external sender not on allowlist is blocked');
  assert((await handleAllow({ type: 'up:status' }, { external: true, id: 'trusted-ext-id' })).ok === true, 'allowlisted external sender is permitted');

  // agent error -> ok:false (no throw)
  const handleErr = createMessageHandler({ agent: { payer: '0x0', async vaultAddress() { throw new Error('boom'); } } });
  assert((await handleErr({ type: 'up:status' })).error === 'boom', 'agent errors are returned, not thrown');

  // bridge over the handler
  const bridge = createBridge((m) => handle(m, null));
  const res = await bridge.upFetch('https://api.example/x402');
  assert(res instanceof Response && res.status === 200 && (await res.text()) === 'paid-body', 'bridge.upFetch returns a real Response');
  const s2 = await bridge.status();
  assert(s2.payer === agent.payer, 'bridge.status returns payer');
  let threw = false;
  try { await createBridge(async () => ({ ok: false, error: 'denied' })).status(); } catch (e) { threw = e.message === 'denied'; }
  assert(threw, 'bridge surfaces handler errors as throws');

  console.log(`\nEXTENSION CORE TEST PASS (${passed} assertions)`);
  process.exit(0);
}
main().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
