/**
 * Mastodon REAL full-stack L3 — a live Mastodon fetches our provider.
 *
 * Stands up our donation-campaign provider and asks a REAL Mastodon instance
 * (configured with DONATION_CAMPAIGNS_URL -> our provider) for
 * GET /api/v1/donation_campaigns as an authenticated user. Mastodon's controller
 * fetches our provider (SSRF-guarded, force_ssl, caches 1h) and returns our
 * campaign. No Mastodon edit.
 *
 * Proven 2026-06-22 (Mastodon v4.x): real Mastodon fetched the provider with its
 * real query (?environment&locale&platform&seed) and returned our campaign (200).
 *
 * PREREQUISITES (acceptance harness; the heaviest stack):
 *   1. dockerd (root). 2. packages built. (No anvil/chain — the provider only serves
 *      config; the donation MONEY loop is the separate e2e:mastodon.)
 *   3. A live Mastodon (postgres + redis + puma), bootstrapped + configured. The
 *      bring-up (real, version-sensitive) — see testing-plan.md (Mastodon row):
 *      - generate SECRET_KEY_BASE, OTP_SECRET, VAPID keys, db:encryption:init keys;
 *      - postgres:14-alpine + redis:7-alpine; db:schema:load + db:seed;
 *      - run `bin/rails server`; create an approved Owner user + a read-scope
 *        Doorkeeper access token (rails runner; bypass email MX validation);
 *      - env: DONATION_CAMPAIGNS_URL=http://localhost:8500/api/v1/donation_campaigns,
 *        ALLOWED_PRIVATE_ADDRESSES=127.0.0.1 (SSRF guard allows the local provider);
 *      - this image needs config.x.mastodon.donation_campaigns bridged to
 *        config.x.donation_campaigns (version skew) — see /tmp/zz_dc_bridge.rb.
 *      Write the access token to /tmp/mast_tok.
 *      Note: requests use `X-Forwarded-Proto: https` to satisfy production force_ssl.
 * Run from repo root: node packages/integrations/scripts/e2e-mastodon-live-docker.mjs
 */
import { readFileSync } from 'node:fs';
import { createSidecarServer, mastodonCampaignRoute } from '../dist/index.js';

const MASTODON = 'http://localhost:3000';

async function main() {
  const token = readFileSync('/tmp/mast_tok', 'utf8').trim();
  const campaign = {
    id: 'up-instance-1',
    banner_message: 'Support this instance — settles onchain via Universal Paywall',
    banner_button_text: 'Donate',
    donation_message: 'Your contribution settles onchain, non-custodially.',
    donation_button_text: 'Contribute',
    donation_success_post: 'I just supported this instance via Universal Paywall.',
    amounts: { one_time: { USD: [1_000_000, 5_000_000, 10_000_000] }, monthly: { USD: [5_000_000] } },
    default_currency: 'USD',
    donation_url: 'https://pay.example/donate?recipient=0x90F7...&amount=5000000',
  };

  let fetched = null;
  const base = mastodonCampaignRoute({ campaign });
  const provider = createSidecarServer([{ ...base, handle: async (ctx) => { fetched = ctx.url.search; console.log('  >>> REAL MASTODON FETCHED our provider:', ctx.url.pathname + ctx.url.search); return base.handle(ctx); } }]);
  await new Promise((r) => provider.listen(8500, () => r(null)));

  console.log('Asking REAL Mastodon for /api/v1/donation_campaigns (authenticated)...');
  const res = await fetch(`${MASTODON}/api/v1/donation_campaigns`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-Proto': 'https' } });
  const body = await res.text();
  let ok = false;
  if (res.status === 200) {
    const j = JSON.parse(body);
    console.log('  campaign from Mastodon: id=' + j.id + ' locale=' + j.locale + ' amounts.one_time.USD=' + JSON.stringify(j.amounts?.one_time?.USD));
    ok = j.id === 'up-instance-1' && fetched !== null;
  } else {
    console.log('  status', res.status, 'body', body.slice(0, 160));
  }
  provider.close();
  if (ok) {
    console.log('\nREAL MASTODON L3 PASS: live Mastodon fetched our provider (query ' + fetched + ') and returned our campaign to an authenticated client');
    process.exit(0);
  }
  process.exit(1);
}
main().catch((e) => { console.error('L3 ERROR:', e && e.message); process.exit(1); });
