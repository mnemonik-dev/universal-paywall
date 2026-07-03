import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Reporter, ReportInput, ReportOutcome } from '../core.js';
import { createSubsonicProxy, isScrobbleSubmission } from '../subsonic-proxy.js';

function spyReporter() {
  const calls: ReportInput[] = [];
  const reporter: Reporter = {
    async report(input: ReportInput): Promise<ReportOutcome> {
      calls.push(input);
      return { status: 'charged', id: `c_${calls.length}`, payer: '0x1' as never, creator: '0x2' as never, amount: input.amount };
    },
  };
  return { calls, reporter };
}

/** A fake Subsonic server that 200s scrobble.view + a generic ping. */
function fakeSubsonic(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok' } }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

async function withProxy(upstreamUrl: string, reporter: Reporter, fn: (base: string) => Promise<void>) {
  const proxy = createServer(createSubsonicProxy({ upstreamUrl, reporter, ratePerPlay: 3n }));
  await new Promise<void>((r) => proxy.listen(0, r));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 60));

describe('isScrobbleSubmission', () => {
  it('matches a scrobble submission with an id, excludes now-playing', () => {
    expect(isScrobbleSubmission(new URL('http://x/rest/scrobble.view?u=alice&id=t1'))).toBe(true);
    expect(isScrobbleSubmission(new URL('http://x/rest/scrobble.view?u=alice&id=t1&submission=true'))).toBe(true);
    expect(isScrobbleSubmission(new URL('http://x/rest/scrobble.view?u=alice&id=t1&submission=false'))).toBe(false); // now playing
    expect(isScrobbleSubmission(new URL('http://x/rest/scrobble.view?u=alice'))).toBe(false); // no id
    expect(isScrobbleSubmission(new URL('http://x/rest/ping.view?u=alice'))).toBe(false);
  });
});

describe('createSubsonicProxy', () => {
  it('meters a scrobble submission (proxying the response through)', async () => {
    const { url, server } = await fakeSubsonic();
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        const res = await fetch(`${base}/rest/scrobble.view?u=alice&id=track-9&time=1700000000000&submission=true&c=app&v=1.16.1`);
        expect(res.status).toBe(200);
        expect((await res.json())['subsonic-response'].status).toBe('ok'); // proxied through
        await tick();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ payerKey: 'alice', creatorKey: 'track-9', amount: 3n });
      });
    } finally {
      server.close();
    }
  });

  it('does not meter a now-playing update (submission=false)', async () => {
    const { url, server } = await fakeSubsonic();
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        await fetch(`${base}/rest/scrobble.view?u=alice&id=track-9&submission=false`);
        await tick();
        expect(calls).toHaveLength(0);
      });
    } finally {
      server.close();
    }
  });

  it('passes non-scrobble requests through without metering', async () => {
    const { url, server } = await fakeSubsonic();
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        const res = await fetch(`${base}/rest/ping.view?u=alice`);
        expect(res.status).toBe(200);
        await tick();
        expect(calls).toHaveLength(0);
      });
    } finally {
      server.close();
    }
  });
});
