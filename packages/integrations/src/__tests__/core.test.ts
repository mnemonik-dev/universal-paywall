import { describe, expect, it, vi } from 'vitest';
import { createReporter, mapResolver, type Hex } from '../core.js';

const USER = 'alice';
const TRACK = 'track-123';
const PAYER = '0x1111111111111111111111111111111111111111' as Hex;
const CREATOR = '0x2222222222222222222222222222222222222222' as Hex;

function fakeClient() {
  const charge = vi.fn(async () => ({ id: 'c_1' }));
  return { charge };
}

describe('createReporter', () => {
  it('resolves both wallets and reports a charge', async () => {
    const client = fakeClient();
    const reporter = createReporter({
      client,
      resolvePayer: mapResolver({ [USER]: PAYER }),
      resolveCreator: mapResolver({ [TRACK]: CREATOR }),
    });

    const out = await reporter.report({ payerKey: USER, creatorKey: TRACK, amount: 100n, ref: 'r1' });
    expect(out).toMatchObject({ status: 'charged', id: 'c_1', payer: PAYER, creator: CREATOR, amount: 100n });
    expect(client.charge).toHaveBeenCalledWith({ payer: PAYER, creator: CREATOR, amount: 100n, ref: 'r1' });
  });

  it('skips when the payer is unresolved (no charge)', async () => {
    const client = fakeClient();
    const reporter = createReporter({
      client,
      resolvePayer: mapResolver({}),
      resolveCreator: mapResolver({ [TRACK]: CREATOR }),
    });
    expect(await reporter.report({ payerKey: USER, creatorKey: TRACK, amount: 100n })).toEqual({ status: 'unresolved_payer' });
    expect(client.charge).not.toHaveBeenCalled();
  });

  it('skips when the creator is unresolved', async () => {
    const client = fakeClient();
    const reporter = createReporter({
      client,
      resolvePayer: mapResolver({ [USER]: PAYER }),
      resolveCreator: mapResolver({}),
    });
    expect(await reporter.report({ payerKey: USER, creatorKey: TRACK, amount: 100n })).toEqual({ status: 'unresolved_creator' });
  });

  it('rejects non-positive amounts', async () => {
    const reporter = createReporter({
      client: fakeClient(),
      resolvePayer: mapResolver({ [USER]: PAYER }),
      resolveCreator: mapResolver({ [TRACK]: CREATOR }),
    });
    expect(await reporter.report({ payerKey: USER, creatorKey: TRACK, amount: 0n })).toEqual({ status: 'zero_amount' });
  });

  it('throws without a client or facilitator config', () => {
    expect(() => createReporter({ resolvePayer: () => null, resolveCreator: () => null })).toThrow(
      'requires `client`',
    );
  });
});
