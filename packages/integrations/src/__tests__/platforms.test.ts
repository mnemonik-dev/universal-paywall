import { describe, expect, it } from 'vitest';
import type { Hex, Reporter, ReportInput, ReportOutcome } from '../core.js';
import { handleScrobble, parseSubsonicScrobble } from '../subsonic.js';
import { OwncastPresenceMeter } from '../owncast.js';
import { handleJellyfinEvent } from '../jellyfin.js';
import { handleCitation } from '../rsshub.js';

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

describe('subsonic scrobble', () => {
  it('reports a per-play charge keyed by user + track', async () => {
    const { calls, reporter } = spyReporter();
    await handleScrobble({ userId: 'alice', mediaFileId: 'track-1', timestamp: 42 }, reporter, { ratePerPlay: 10n });
    expect(calls[0]).toEqual({ payerKey: 'alice', creatorKey: 'track-1', amount: 10n, ref: 'scrobble:alice:track-1:42' });
  });

  it('parses a Subsonic scrobble.view query (ms → seconds)', () => {
    const ev = parseSubsonicScrobble(new URLSearchParams('u=bob&id=song9&time=1700000000000'));
    expect(ev).toEqual({ userId: 'bob', mediaFileId: 'song9', timestamp: 1700000000 });
    expect(parseSubsonicScrobble(new URLSearchParams('u=bob'))).toBeNull();
  });
});

describe('owncast presence', () => {
  it('bills (parted - joined) * ratePerSecond on part', async () => {
    const { calls, reporter } = spyReporter();
    const meter = new OwncastPresenceMeter(reporter, { ratePerSecond: 5n, streamerKey: 'streamer' });

    await meter.handle({ type: 'USER_JOINED', eventData: { user: { id: 'v1' } } }, 100);
    expect(meter.activeViewers()).toBe(1);
    const out = await meter.handle({ type: 'USER_PARTED', eventData: { user: { id: 'v1' } } }, 160);

    expect(out?.status).toBe('charged');
    expect(calls[0]).toEqual({ payerKey: 'v1', creatorKey: 'streamer', amount: 300n, ref: 'owncast:v1:100-160' });
    expect(meter.activeViewers()).toBe(0);
  });

  it('ignores a part with no recorded join', async () => {
    const { calls, reporter } = spyReporter();
    const meter = new OwncastPresenceMeter(reporter, { ratePerSecond: 5n, streamerKey: 's' });
    expect(await meter.handle({ type: 'USER_PARTED', eventData: { user: { id: 'ghost' } } }, 10)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('jellyfin vod', () => {
  it('bills whole minutes on PlaybackStop', async () => {
    const { calls, reporter } = spyReporter();
    // 3 minutes = 3 * 600,000,000 ticks
    await handleJellyfinEvent(
      { NotificationType: 'PlaybackStop', UserId: 'u', ItemId: 'movie', PlaybackPositionTicks: 1_800_000_000 },
      reporter,
      { ratePerMinute: 100n },
    );
    expect(calls[0]?.amount).toBe(300n);
    expect(calls[0]?.payerKey).toBe('u');
    expect(calls[0]?.creatorKey).toBe('movie');
  });

  it('ignores progress events and sub-minute stops', async () => {
    const { calls, reporter } = spyReporter();
    expect(await handleJellyfinEvent({ NotificationType: 'PlaybackProgress', UserId: 'u', ItemId: 'm', PlaybackPositionTicks: 9_000_000_000 }, reporter, { ratePerMinute: 1n })).toBeNull();
    expect(await handleJellyfinEvent({ NotificationType: 'PlaybackStop', UserId: 'u', ItemId: 'm', PlaybackPositionTicks: 1000 }, reporter, { ratePerMinute: 1n })).toEqual({ status: 'zero_amount' });
    expect(calls).toHaveLength(0);
  });
});

describe('rsshub citation toll', () => {
  it('prefers the author as payee, falls back to the link', async () => {
    const { calls, reporter } = spyReporter();
    await handleCitation({ crawlerId: 'gpt', link: 'https://src/post', author: 'https://author' }, reporter, { toll: 7n });
    expect(calls[0]).toEqual({ payerKey: 'gpt', creatorKey: 'https://author', amount: 7n, ref: 'citation:gpt:https://src/post' });

    await handleCitation({ crawlerId: 'gpt', link: 'https://src/post2' }, reporter, { toll: 7n });
    expect(calls[1]?.creatorKey).toBe('https://src/post2');
  });
});
