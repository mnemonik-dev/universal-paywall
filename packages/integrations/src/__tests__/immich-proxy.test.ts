import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Reporter, ReportInput, ReportOutcome } from '../core.js';
import { createImmichProxy, parseAssetResolve } from '../immich-proxy.js';

const ASSET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

/** A tiny fake Immich: serves asset files + the asset metadata (ownerId + exif). */
function fakeImmich(opts: { artist?: string }): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === `/api/assets/${ASSET}` && url.searchParams.get('key')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ownerId: 'owner-1', exifInfo: opts.artist ? { artist: opts.artist } : {} }));
      return;
    }
    if (url.pathname.startsWith(`/api/assets/${ASSET}/`)) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end('JPEGBYTES');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

async function withProxy(upstreamUrl: string, reporter: Reporter, fn: (base: string) => Promise<void>) {
  const proxy = createServer(createImmichProxy({ upstreamUrl, reporter, licenseFee: 7n, dedupeMs: 60_000 }));
  await new Promise<void>((r) => proxy.listen(0, r));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 80));

describe('parseAssetResolve', () => {
  it('matches a shared-asset GET with key/slug only', () => {
    expect(parseAssetResolve('GET', new URL(`http://x/api/assets/${ASSET}/original?key=share1`))).toEqual({ assetId: ASSET, share: 'share1' });
    expect(parseAssetResolve('GET', new URL(`http://x/api/assets/${ASSET}/thumbnail?slug=my-album`))).toEqual({ assetId: ASSET, share: 'my-album' });
    expect(parseAssetResolve('GET', new URL(`http://x/api/assets/${ASSET}/original`))).toBeNull(); // no share key -> owner's own view
    expect(parseAssetResolve('POST', new URL(`http://x/api/assets/${ASSET}/original?key=s`))).toBeNull();
    expect(parseAssetResolve('GET', new URL('http://x/api/albums?key=s'))).toBeNull();
  });
});

describe('createImmichProxy', () => {
  it('meters a shared-asset resolve to the EXIF artist (proxying the bytes through)', async () => {
    const { url, server } = await fakeImmich({ artist: 'Ansel' });
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        const res = await fetch(`${base}/api/assets/${ASSET}/original?key=share1`, { headers: { 'x-resolver-id': 'agent-9' } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('JPEGBYTES'); // bytes proxied through
        await tick();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ payerKey: 'agent-9', creatorKey: 'Ansel', amount: 7n });
        expect(calls[0]?.ref).toBe(`immich:agent-9:${ASSET}`);
      });
    } finally {
      server.close();
    }
  });

  it('falls back to ownerId when EXIF artist is absent', async () => {
    const { url, server } = await fakeImmich({});
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        await fetch(`${base}/api/assets/${ASSET}/original?key=share1`);
        await tick();
        expect(calls[0]).toMatchObject({ creatorKey: 'owner-1', payerKey: 'share1' });
      });
    } finally {
      server.close();
    }
  });

  it('dedupes thumbnail+original of one view to a single charge', async () => {
    const { url, server } = await fakeImmich({ artist: 'Ansel' });
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        await fetch(`${base}/api/assets/${ASSET}/thumbnail?key=share1`);
        await fetch(`${base}/api/assets/${ASSET}/original?key=share1`);
        await tick();
        expect(calls).toHaveLength(1);
      });
    } finally {
      server.close();
    }
  });

  it('does not meter the owner viewing their own asset (no share key)', async () => {
    const { url, server } = await fakeImmich({ artist: 'Ansel' });
    const { calls, reporter } = spyReporter();
    try {
      await withProxy(url, reporter, async (base) => {
        const res = await fetch(`${base}/api/assets/${ASSET}/original`);
        expect(res.status).toBe(200);
        await tick();
        expect(calls).toHaveLength(0);
      });
    } finally {
      server.close();
    }
  });
});
