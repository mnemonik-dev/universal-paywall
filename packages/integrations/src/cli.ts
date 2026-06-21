import { createReporter, mapResolver, type Hex } from './core.js';
import { OwncastPresenceMeter } from './owncast.js';
import {
  citationRoute,
  createSidecarServer,
  immichRoute,
  jellyfinRoute,
  owncastRoute,
  subsonicRoute,
  type Route,
} from './serve.js';

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`missing env: ${name}`);
  return v;
}

function jsonMap(name: string): Record<string, Hex> {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return {};
  return JSON.parse(raw) as Record<string, Hex>;
}

function rate(): bigint {
  return BigInt(env('RATE'));
}

function main(): void {
  const platform = env('PLATFORM');
  const reporter = createReporter({
    facilitatorUrl: env('FACILITATOR_URL'),
    apiKey: env('FACILITATOR_API_KEY'),
    resolvePayer: mapResolver(jsonMap('PAYER_WALLETS')),
    resolveCreator: mapResolver(jsonMap('CREATOR_WALLETS')),
  });

  let route: Route;
  switch (platform) {
    case 'subsonic':
      route = subsonicRoute(reporter, { ratePerPlay: rate() });
      break;
    case 'owncast':
      route = owncastRoute(new OwncastPresenceMeter(reporter, { ratePerSecond: rate(), streamerKey: env('STREAMER_KEY') }));
      break;
    case 'jellyfin':
      route = jellyfinRoute(reporter, { ratePerMinute: rate() });
      break;
    case 'rsshub':
      route = citationRoute(reporter, { toll: rate() });
      break;
    case 'immich':
      route = immichRoute(reporter, { licenseFee: rate() });
      break;
    default:
      throw new Error(`unknown PLATFORM: ${platform} (use subsonic|owncast|jellyfin|rsshub|immich)`);
  }

  const server = createSidecarServer([route], {
    ...(process.env.SIDECAR_API_KEY !== undefined ? { apiKey: process.env.SIDECAR_API_KEY } : {}),
  });
  const port = Number(process.env.PORT ?? '8410');
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`up-integration [${platform}] listening on :${port} (path ${route.path})`);
  });
}

main();
