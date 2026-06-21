import { describe, expect, it } from 'vitest';
import type { Hex, Reporter, ReportInput, ReportOutcome } from '../core.js';
import { handleSharedLinkResolve } from '../immich.js';
import { citationRoute, immichRoute, listenBrainzRoutes, owncastRoute, subsonicRoute } from '../serve.js';
import { OwncastPresenceMeter } from '../owncast.js';
import { handleListenSubmit, listenCreatorKey, parseListenToken } from '../listenbrainz.js';
import type { IncomingHttpHeaders } from 'node:http';

const NO_HEADERS: IncomingHttpHeaders = {};

const P = '0x1111111111111111111111111111111111111111' as Hex;
const C = '0x2222222222222222222222222222222222222222' as Hex;

function spyReporter() {
  const calls: ReportInput[] = [];
  const reporter: Reporter = {
    async report(input: ReportInput): Promise<ReportOutcome> {
      calls.push(input);
      return { status: 'charged', id: `c_${calls.length}`, payer: P, creator: C, amount: input.amount };
    },
  };
  return { calls, reporter };
}

describe('immich shared-link', () => {
  it('pays the EXIF Artist, falling back to ownerId', async () => {
    const { calls, reporter } = spyReporter();
    await handleSharedLinkResolve({ resolverId: 'agent', assetId: 'a1', exifArtist: 'photog', ownerId: 'uploader' }, reporter, { licenseFee: 9n });
    expect(calls[0]).toEqual({ payerKey: 'agent', creatorKey: 'photog', amount: 9n, ref: 'immich:agent:a1' });

    await handleSharedLinkResolve({ resolverId: 'agent', assetId: 'a2', ownerId: 'uploader' }, reporter, { licenseFee: 9n });
    expect(calls[1]?.creatorKey).toBe('uploader');
  });
});

describe('route builders', () => {
  it('subsonic GET route parses the scrobble query', async () => {
    const { calls, reporter } = spyReporter();
    const route = subsonicRoute(reporter, { ratePerPlay: 3n });
    expect(route.method).toBe('GET');
    await route.handle({ body: null, url: new URL('http://x/rest/scrobble.view?u=alice&id=t1'), headers: NO_HEADERS });
    expect(calls[0]).toMatchObject({ payerKey: 'alice', creatorKey: 't1', amount: 3n });
  });

  it('owncast POST route meters presence', async () => {
    const { calls, reporter } = spyReporter();
    const route = owncastRoute(new OwncastPresenceMeter(reporter, { ratePerSecond: 2n, streamerKey: 's' }));
    await route.handle({ body: { type: 'USER_JOINED', eventData: { user: { id: 'v' }, timestamp: '2026-01-01T00:00:00Z' } }, url: new URL('http://x/owncast'), headers: NO_HEADERS });
    const out = await route.handle({ body: { type: 'USER_PARTED', eventData: { user: { id: 'v' }, timestamp: '2026-01-01T00:00:10Z' } }, url: new URL('http://x/owncast'), headers: NO_HEADERS });
    expect((out as ReportOutcome).status).toBe('charged');
    expect(calls[0]?.amount).toBe(20n); // 10s * 2
  });

  it('citation POST route tolls the author', async () => {
    const { calls, reporter } = spyReporter();
    const route = citationRoute(reporter, { toll: 4n });
    await route.handle({ body: { crawlerId: 'gpt', link: 'https://s/p', author: 'https://a' }, url: new URL('http://x/citation'), headers: NO_HEADERS });
    expect(calls[0]).toMatchObject({ payerKey: 'gpt', creatorKey: 'https://a', amount: 4n });
  });

  it('immich POST route charges a license fee', async () => {
    const { calls, reporter } = spyReporter();
    const route = immichRoute(reporter, { licenseFee: 5n });
    await route.handle({ body: { resolverId: 'agent', assetId: 'a1', ownerId: 'u' }, url: new URL('http://x/immich/resolve'), headers: NO_HEADERS });
    expect(calls[0]).toMatchObject({ payerKey: 'agent', creatorKey: 'u', amount: 5n });
  });

  it('listenbrainz validate-token always links and echoes the token as user_name', async () => {
    const { reporter } = spyReporter();
    const [validate] = listenBrainzRoutes(reporter, { ratePerListen: 7n });
    expect(validate).toMatchObject({ method: 'GET', path: '/1/validate-token' });
    const out = await validate.handle({ body: null, url: new URL('http://x/1/validate-token'), headers: { authorization: 'Token tok-alice' } });
    expect(out).toMatchObject({ valid: true, user_name: 'tok-alice', code: 200 });
  });

  it('listenbrainz submit-listens charges the token-payer for the recording MBID', async () => {
    const { calls, reporter } = spyReporter();
    const [, submit] = listenBrainzRoutes(reporter, { ratePerListen: 7n });
    expect(submit).toMatchObject({ method: 'POST', path: '/1/submit-listens' });
    const body = {
      listen_type: 'single',
      payload: [{ listened_at: 1700000000, track_metadata: { additional_info: { recording_mbid: 'rec-1', artist_mbids: ['art-1'] } } }],
    };
    const out = await submit.handle({ body, url: new URL('http://x/1/submit-listens'), headers: { authorization: 'Token tok-alice' } });
    expect(out).toEqual({ status: 'ok' });
    expect(calls[0]).toMatchObject({ payerKey: 'tok-alice', creatorKey: 'rec-1', amount: 7n });
  });

  it('listenbrainz skips playing_now (no charge) but still returns ok', async () => {
    const { calls, reporter } = spyReporter();
    const [, submit] = listenBrainzRoutes(reporter, { ratePerListen: 7n });
    const out = await submit.handle({
      body: { listen_type: 'playing_now', payload: [{ track_metadata: { additional_info: { recording_mbid: 'rec-1' } } }] },
      url: new URL('http://x/1/submit-listens'),
      headers: { authorization: 'Token tok-alice' },
    });
    expect(out).toEqual({ status: 'ok' });
    expect(calls).toHaveLength(0);
  });
});

describe('listenbrainz adapter', () => {
  it('parseListenToken extracts the bearer-style Token header', () => {
    expect(parseListenToken('Token abc')).toBe('abc');
    expect(parseListenToken('token  spaced  ')).toBe('spaced');
    expect(parseListenToken(['Token first', 'Token second'])).toBe('first');
    expect(parseListenToken(undefined)).toBeNull();
    expect(parseListenToken('Bearer xyz')).toBeNull();
  });

  it('listenCreatorKey prefers recording_mbid, falls back to first artist_mbid', () => {
    expect(listenCreatorKey({ track_metadata: { additional_info: { recording_mbid: 'r', artist_mbids: ['a'] } } })).toBe('r');
    expect(listenCreatorKey({ track_metadata: { additional_info: { artist_mbids: ['', 'a2'] } } })).toBe('a2');
    expect(listenCreatorKey({ track_metadata: { additional_info: {} } })).toBeNull();
    expect(listenCreatorKey({})).toBeNull();
  });

  it('handleListenSubmit skips unresolved-creator items but bills the rest', async () => {
    const { calls, reporter } = spyReporter();
    const outcomes = await handleListenSubmit(
      {
        listen_type: 'single',
        payload: [
          { track_metadata: { additional_info: { recording_mbid: 'r1' } } },
          { track_metadata: { additional_info: {} } }, // no mbid → unresolved_creator
        ],
      },
      'tok',
      reporter,
      { ratePerListen: 2n },
    );
    expect(outcomes.map((o) => o.status)).toEqual(['charged', 'unresolved_creator']);
    expect(calls).toHaveLength(1);
  });

  it('handleListenSubmit charges nothing without a token', async () => {
    const { calls, reporter } = spyReporter();
    const outcomes = await handleListenSubmit(
      { listen_type: 'single', payload: [{ track_metadata: { additional_info: { recording_mbid: 'r1' } } }] },
      null,
      reporter,
      { ratePerListen: 2n },
    );
    expect(outcomes).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
