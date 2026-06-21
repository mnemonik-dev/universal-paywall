import { describe, expect, it, vi } from 'vitest';
import { createPaywallClient, type Hex } from '../index.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const CREATOR = '0x2222222222222222222222222222222222222222' as Hex;

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 202, headers: { 'content-type': 'application/json' } });
}

describe('createPaywallClient', () => {
  it('posts a charge with auth header and stringified amount', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'c_1' }));
    const client = createPaywallClient({ facilitatorUrl: 'https://f.example.com/', apiKey: 'k1', fetchImpl });

    const ack = await client.charge({ payer: PAYER, creator: CREATOR, amount: 10_000n, ref: 'r1' });
    expect(ack.id).toBe('c_1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://f.example.com/charge'); // trailing slash trimmed
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k1');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ payer: PAYER, creator: CREATOR, amount: '10000', ref: 'r1' });
  });

  it('omits ref when not provided', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'c_2' }));
    const client = createPaywallClient({ facilitatorUrl: 'https://f.example.com', apiKey: 'k1', fetchImpl });
    await client.charge({ payer: PAYER, creator: CREATOR, amount: 1n });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect('ref' in body).toBe(false);
  });

  it('rejects non-positive amounts before calling fetch', async () => {
    const fetchImpl = vi.fn();
    const client = createPaywallClient({ facilitatorUrl: 'https://f.example.com', apiKey: 'k1', fetchImpl });
    await expect(client.charge({ payer: PAYER, creator: CREATOR, amount: 0n })).rejects.toThrow(
      'amount_must_be_positive',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const client = createPaywallClient({ facilitatorUrl: 'https://f.example.com', apiKey: 'bad', fetchImpl });
    await expect(client.charge({ payer: PAYER, creator: CREATOR, amount: 1n })).rejects.toThrow('charge_failed: 401');
  });
});
