import { describe, expect, it, vi } from 'vitest';
import type { Hex } from '../core.js';
import { createReporter, mapResolver } from '../core.js';
import { createMusicBrainzResolver } from '../musicbrainz.js';

const ARTIST_MBID = '11111111-1111-4111-8111-111111111111';
const RECORDING_MBID = '22222222-2222-4222-8222-222222222222';
const WALLET = '0x1111111111111111111111111111111111111111' as Hex;

/** A fetch stub returning a WS/2 recording payload crediting ARTIST_MBID. */
function recordingFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ 'artist-credit': [{ artist: { id: ARTIST_MBID } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('createMusicBrainzResolver', () => {
  it('resolves a recording MBID to the artist wallet via WS/2', async () => {
    const fetchImpl = recordingFetch();
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({ [ARTIST_MBID]: WALLET }),
      userAgent: 'up-test/0.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    expect(await resolve(RECORDING_MBID)).toBe(WALLET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`/recording/${RECORDING_MBID}?inc=artists&fmt=json`);
  });

  it('fast-path: a directly-registered key returns without any WS/2 call', async () => {
    const fetchImpl = recordingFetch();
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({ [ARTIST_MBID]: WALLET }),
      userAgent: 'up-test/0.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    expect(await resolve(ARTIST_MBID)).toBe(WALLET);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches recording->artists (one WS/2 call for repeated lookups)', async () => {
    const fetchImpl = recordingFetch();
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({ [ARTIST_MBID]: WALLET }),
      userAgent: 'up-test/0.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    await resolve(RECORDING_MBID);
    await resolve(RECORDING_MBID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unregistered artist (meter-and-skip)', async () => {
    const fetchImpl = recordingFetch();
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({}), // empty registry
      userAgent: 'up-test/0.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    expect(await resolve(RECORDING_MBID)).toBeNull();
  });

  it('skips WS/2 for non-MBID keys and returns null', async () => {
    const fetchImpl = recordingFetch();
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({}),
      userAgent: 'up-test/0.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    expect(await resolve('not-an-mbid')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws on a WS/2 error -> null', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream down', { status: 503 }));
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({ [ARTIST_MBID]: WALLET }),
      userAgent: 'up-test/0.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    expect(await resolve(RECORDING_MBID)).toBeNull();
  });

  it('sends the required User-Agent header', async () => {
    const fetchImpl = recordingFetch();
    const resolve = createMusicBrainzResolver({
      walletRegistry: mapResolver({ [ARTIST_MBID]: WALLET }),
      userAgent: 'up-test/9.9 (ops@example.com)',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minIntervalMs: 0,
    });
    await resolve(RECORDING_MBID);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('up-test/9.9 (ops@example.com)');
  });

  it('flows through createReporter as an async resolveCreator', async () => {
    const fetchImpl = recordingFetch();
    const charges: Array<{ payer: Hex; creator: Hex; amount: bigint; ref?: string }> = [];
    const reporter = createReporter({
      resolvePayer: mapResolver({ alice: '0x2222222222222222222222222222222222222222' as Hex }),
      resolveCreator: createMusicBrainzResolver({
        walletRegistry: mapResolver({ [ARTIST_MBID]: WALLET }),
        userAgent: 'up-test/0.1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        minIntervalMs: 0,
      }),
      client: { charge: async (c) => { charges.push(c); return { id: 'c1' }; } },
    });
    const out = await reporter.report({ payerKey: 'alice', creatorKey: RECORDING_MBID, amount: 5n });
    expect(out.status).toBe('charged');
    expect(charges[0]?.creator).toBe(WALLET);
  });
});
