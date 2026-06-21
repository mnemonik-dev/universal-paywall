import { createReporter, mapResolver, type Hex, type Reporter, type Resolve } from './core.js';
import { OwncastPresenceMeter } from './owncast.js';
import { createMusicBrainzResolver } from './musicbrainz.js';
import type { CampaignAmounts, CampaignTemplate } from './mastodon.js';
import {
  citationRoute,
  createSidecarServer,
  immichRoute,
  jellyfinRoute,
  listenBrainzRoutes,
  mastodonCampaignRoute,
  owncastRoute,
  subsonicRoute,
  type Route,
} from './serve.js';

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`missing env: ${name}`);
  return v;
}

function optEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function jsonMap(name: string): Record<string, Hex> {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return {};
  return JSON.parse(raw) as Record<string, Hex>;
}

function rate(): bigint {
  return BigInt(env('RATE'));
}

/** Builds the donation campaign from env: a full `CAMPAIGN_JSON`, or discrete vars. */
function campaignFromEnv(): CampaignTemplate {
  const raw = process.env.CAMPAIGN_JSON;
  if (raw !== undefined && raw !== '') return JSON.parse(raw) as CampaignTemplate;
  const amounts = process.env.CAMPAIGN_AMOUNTS;
  return {
    id: optEnv('CAMPAIGN_ID', 'universal-paywall'),
    banner_message: optEnv('CAMPAIGN_BANNER_MESSAGE', 'Support this instance — settles onchain via Universal Paywall'),
    banner_button_text: optEnv('CAMPAIGN_BANNER_BUTTON_TEXT', 'Donate'),
    donation_message: optEnv('CAMPAIGN_DONATION_MESSAGE', 'Your contribution settles onchain, non-custodially.'),
    donation_button_text: optEnv('CAMPAIGN_DONATION_BUTTON_TEXT', 'Contribute'),
    donation_success_post: optEnv('CAMPAIGN_DONATION_SUCCESS_POST', 'I just supported this instance via Universal Paywall.'),
    amounts: amounts !== undefined && amounts !== '' ? (JSON.parse(amounts) as CampaignAmounts) : { one_time: { USD: [5, 10, 25] }, monthly: { USD: [5] } },
    default_currency: optEnv('CAMPAIGN_DEFAULT_CURRENCY', 'USD'),
    donation_url: env('CAMPAIGN_DONATION_URL'),
  };
}

function main(): void {
  const platform = env('PLATFORM');
  // Built lazily: the Mastodon provider serves config and needs no facilitator.
  // An optional `resolveCreator` override lets music platforms plug in the
  // MusicBrainz registry (recording_mbid -> artist_mbid -> wallet).
  const reporter = (resolveCreator?: Resolve): Reporter =>
    createReporter({
      facilitatorUrl: env('FACILITATOR_URL'),
      apiKey: env('FACILITATOR_API_KEY'),
      resolvePayer: mapResolver(jsonMap('PAYER_WALLETS')),
      resolveCreator: resolveCreator ?? mapResolver(jsonMap('CREATOR_WALLETS')),
    });

  // If MUSICBRAINZ_USER_AGENT is set, wrap CREATOR_WALLETS (keyed on artist_mbid)
  // with a MusicBrainz resolver so scrobbled recording_mbids resolve to artists.
  function musicCreatorResolver(): Resolve {
    const registry = mapResolver(jsonMap('CREATOR_WALLETS'));
    const ua = process.env.MUSICBRAINZ_USER_AGENT;
    if (ua === undefined || ua === '') return registry;
    return createMusicBrainzResolver({
      walletRegistry: registry,
      userAgent: ua,
      ...(process.env.MUSICBRAINZ_BASE_URL !== undefined ? { baseUrl: process.env.MUSICBRAINZ_BASE_URL } : {}),
    });
  }

  let routes: readonly Route[];
  switch (platform) {
    case 'subsonic':
      routes = [subsonicRoute(reporter(musicCreatorResolver()), { ratePerPlay: rate() })];
      break;
    case 'navidrome':
      // Navidrome scrobbles natively to a ListenBrainz target (validate-token + submit-listens).
      routes = listenBrainzRoutes(reporter(musicCreatorResolver()), { ratePerListen: rate() });
      break;
    case 'owncast':
      routes = [owncastRoute(new OwncastPresenceMeter(reporter(), { ratePerSecond: rate(), streamerKey: env('STREAMER_KEY') }))];
      break;
    case 'jellyfin':
      routes = [jellyfinRoute(reporter(), { ratePerMinute: rate() })];
      break;
    case 'rsshub':
      routes = [citationRoute(reporter(), { toll: rate() })];
      break;
    case 'immich':
      routes = [immichRoute(reporter(), { licenseFee: rate() })];
      break;
    case 'mastodon':
      // Donation-campaign provider: serves the banner JSON Mastodon caches.
      routes = [mastodonCampaignRoute({ campaign: campaignFromEnv() })];
      break;
    default:
      throw new Error(`unknown PLATFORM: ${platform} (use subsonic|navidrome|owncast|jellyfin|rsshub|immich|mastodon)`);
  }

  const server = createSidecarServer(routes, {
    ...(process.env.SIDECAR_API_KEY !== undefined ? { apiKey: process.env.SIDECAR_API_KEY } : {}),
  });
  const port = Number(process.env.PORT ?? '8410');
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`up-integration [${platform}] listening on :${port} (paths ${routes.map((r) => r.path).join(', ')})`);
  });
}

main();
