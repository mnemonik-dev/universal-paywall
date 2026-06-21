import { describe, expect, it } from 'vitest';
import { NonceStore } from '../replay-store.js';

const FROM_LOWER = '0xabcdef0123456789012345678901234567890123';
const FROM_UPPER = '0xABCDEF0123456789012345678901234567890123';
const NONCE_A: `0x${string}` = ('0x' + '11'.repeat(32)) as `0x${string}`;
const NONCE_B: `0x${string}` = ('0x' + '22'.repeat(32)) as `0x${string}`;

describe('NonceStore — checkAndInsert', () => {
  it('same (from, nonce) twice → second is rejected with nonce_already_used', () => {
    const store = new NonceStore();
    const r1 = store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
      now: 0,
    });
    expect(r1).toEqual({ accepted: true });
    const r2 = store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
      now: 0,
    });
    expect(r2).toEqual({ accepted: false, reason: 'nonce_already_used' });
  });

  it('distinct nonces under same from are accepted', () => {
    const store = new NonceStore();
    expect(
      store.checkAndInsert({
        from: FROM_LOWER as `0x${string}`,
        nonce: NONCE_A,
        validBefore: 10_000,
        now: 0,
      }).accepted,
    ).toBe(true);
    expect(
      store.checkAndInsert({
        from: FROM_LOWER as `0x${string}`,
        nonce: NONCE_B,
        validBefore: 10_000,
        now: 0,
      }).accepted,
    ).toBe(true);
  });

  it('rejects expired authorization with authorization_expired', () => {
    const store = new NonceStore();
    const r = store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 1000,
      now: 2000,
    });
    expect(r).toEqual({ accepted: false, reason: 'authorization_expired' });
  });
});

describe('NonceStore — TTL eviction', () => {
  it('lazy TTL eviction: expired entries are dropped on subsequent has()', () => {
    const store = new NonceStore();
    store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 1000,
      now: 0,
    });
    expect(store.has({ from: FROM_LOWER as `0x${string}`, nonce: NONCE_A, now: 0 })).toBe(true);
    expect(store.size()).toBe(1);
    expect(store.has({ from: FROM_LOWER as `0x${string}`, nonce: NONCE_A, now: 2000 })).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe('NonceStore — address-case normalization', () => {
  it('upper and lower-case `from` match the same nonce', () => {
    const store = new NonceStore();
    store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
      now: 0,
    });
    const r = store.checkAndInsert({
      from: FROM_UPPER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
      now: 0,
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('nonce_already_used');
  });

  it('nonces are case-insensitive too', () => {
    const store = new NonceStore();
    const lowerN = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const upperN = ('0x' + 'AA'.repeat(32)) as `0x${string}`;
    store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: lowerN,
      validBefore: 10_000,
      now: 0,
    });
    expect(
      store.checkAndInsert({
        from: FROM_LOWER as `0x${string}`,
        nonce: upperN,
        validBefore: 10_000,
        now: 0,
      }).accepted,
    ).toBe(false);
  });
});

describe('NonceStore — 100k cap eviction', () => {
  it('cap eviction by oldest validBefore', () => {
    const cap = 1000;
    const store = new NonceStore({ maxEntries: cap });
    // Use i+1 with 'a' prefix so addresses don't collide with the 'fff…' overflow entry.
    const addr = (i: number) =>
      ('0x' + 'a'.repeat(8) + i.toString(16).padStart(32, '0')) as `0x${string}`;
    const nonceFor = (i: number) =>
      ('0x' + 'b'.repeat(8) + i.toString(16).padStart(56, '0')) as `0x${string}`;
    for (let i = 0; i < cap; i++) {
      store.checkAndInsert({
        from: addr(i),
        nonce: nonceFor(i),
        validBefore: 10_000 + i,
        now: 0,
      });
    }
    expect(store.size()).toBe(cap);

    // oldest entry (i=0)
    expect(store.has({ from: addr(0), nonce: nonceFor(0), now: 0 })).toBe(true);

    // insert one more — oldest must be evicted
    const newFrom = ('0x' + 'f'.repeat(40)) as `0x${string}`;
    const newNonce = ('0x' + 'f'.repeat(64)) as `0x${string}`;
    store.checkAndInsert({
      from: newFrom,
      nonce: newNonce,
      validBefore: 100_000,
      now: 0,
    });

    expect(store.has({ from: addr(0), nonce: nonceFor(0), now: 0 })).toBe(false);
    expect(store.has({ from: newFrom, nonce: newNonce, now: 0 })).toBe(true);
    expect(store.size()).toBe(cap);
  });
});

describe('NonceStore — retention on settlement failure', () => {
  it('checkAndInsert then re-check without explicit delete → still rejects', () => {
    const store = new NonceStore();
    store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
      now: 0,
    });
    // simulate a failed settlement — the API has no delete hook on purpose
    const retry = store.checkAndInsert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
      now: 0,
    });
    expect(retry).toEqual({ accepted: false, reason: 'nonce_already_used' });
  });
});

describe('NonceStore — primitives', () => {
  it('has + insert as separate primitives', () => {
    const store = new NonceStore();
    expect(store.has({ from: FROM_LOWER as `0x${string}`, nonce: NONCE_A, now: 0 })).toBe(false);
    store.insert({
      from: FROM_LOWER as `0x${string}`,
      nonce: NONCE_A,
      validBefore: 10_000,
    });
    expect(store.has({ from: FROM_LOWER as `0x${string}`, nonce: NONCE_A, now: 0 })).toBe(true);
    expect(store.size()).toBe(1);
  });
});
