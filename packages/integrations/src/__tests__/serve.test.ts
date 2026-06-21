import { describe, expect, it } from 'vitest';
import type { Hex, Reporter, ReportInput, ReportOutcome } from '../core.js';
import { handleSharedLinkResolve } from '../immich.js';
import { citationRoute, immichRoute, owncastRoute, subsonicRoute } from '../serve.js';
import { OwncastPresenceMeter } from '../owncast.js';

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
    await route.handle({ body: null, url: new URL('http://x/rest/scrobble.view?u=alice&id=t1') });
    expect(calls[0]).toMatchObject({ payerKey: 'alice', creatorKey: 't1', amount: 3n });
  });

  it('owncast POST route meters presence', async () => {
    const { calls, reporter } = spyReporter();
    const route = owncastRoute(new OwncastPresenceMeter(reporter, { ratePerSecond: 2n, streamerKey: 's' }));
    await route.handle({ body: { type: 'USER_JOINED', eventData: { user: { id: 'v' }, timestamp: '2026-01-01T00:00:00Z' } }, url: new URL('http://x/owncast') });
    const out = await route.handle({ body: { type: 'USER_PARTED', eventData: { user: { id: 'v' }, timestamp: '2026-01-01T00:00:10Z' } }, url: new URL('http://x/owncast') });
    expect((out as ReportOutcome).status).toBe('charged');
    expect(calls[0]?.amount).toBe(20n); // 10s * 2
  });

  it('citation POST route tolls the author', async () => {
    const { calls, reporter } = spyReporter();
    const route = citationRoute(reporter, { toll: 4n });
    await route.handle({ body: { crawlerId: 'gpt', link: 'https://s/p', author: 'https://a' }, url: new URL('http://x/citation') });
    expect(calls[0]).toMatchObject({ payerKey: 'gpt', creatorKey: 'https://a', amount: 4n });
  });

  it('immich POST route charges a license fee', async () => {
    const { calls, reporter } = spyReporter();
    const route = immichRoute(reporter, { licenseFee: 5n });
    await route.handle({ body: { resolverId: 'agent', assetId: 'a1', ownerId: 'u' }, url: new URL('http://x/immich/resolve') });
    expect(calls[0]).toMatchObject({ payerKey: 'agent', creatorKey: 'u', amount: 5n });
  });
});
