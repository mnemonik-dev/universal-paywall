export { createReporter, mapResolver } from './core.js';
export type { Hex, MaybePromise, Reporter, ReporterConfig, ReportInput, ReportOutcome, Resolve } from './core.js';

export { createMusicBrainzResolver } from './musicbrainz.js';
export type { MusicBrainzResolverOptions } from './musicbrainz.js';

export { handleScrobble, parseSubsonicScrobble } from './subsonic.js';
export type { ScrobbleEvent, ScrobbleOptions } from './subsonic.js';

export { OwncastPresenceMeter } from './owncast.js';
export type { OwncastEventType, OwncastMeterOptions, OwncastWebhookEvent } from './owncast.js';

export { handleJellyfinEvent } from './jellyfin.js';
export type { JellyfinMeterOptions, JellyfinWebhookEvent } from './jellyfin.js';

export { handleCitation } from './rsshub.js';
export type { CitationEvent, CitationOptions } from './rsshub.js';

export { handleSharedLinkResolve } from './immich.js';
export type { SharedLinkOptions, SharedLinkResolveEvent } from './immich.js';

export { handleListenSubmit, listenCreatorKey, parseListenToken } from './listenbrainz.js';
export type {
  ListenAdditionalInfo,
  ListenBrainzOptions,
  ListenPayloadItem,
  ListenSubmission,
  ListenTrackMetadata,
} from './listenbrainz.js';

export { buildDonationCampaign } from './mastodon.js';
export type {
  CampaignAmounts,
  CampaignTemplate,
  DonationCampaign,
  DonationCampaignOptions,
  DonationCampaignQuery,
} from './mastodon.js';

export {
  createSidecarServer,
  subsonicRoute,
  owncastRoute,
  jellyfinRoute,
  citationRoute,
  immichRoute,
  listenBrainzRoutes,
  mastodonCampaignRoute,
  RouteResponse,
} from './serve.js';
export type { Route, RouteHandler, SidecarServerOptions } from './serve.js';
