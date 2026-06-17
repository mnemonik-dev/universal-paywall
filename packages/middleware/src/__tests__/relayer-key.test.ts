import { inspect } from 'node:util';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import winston from 'winston';
import { OpaqueRelayerKey, getRelayerKeySecret, scrubSecrets } from '../relayer-key.js';

const RAW_HEX_NO_PREFIX = 'a'.repeat(64);
const RAW_HEX_WITH_PREFIX = '0x' + RAW_HEX_NO_PREFIX;
const RAW_SIG_WITH_PREFIX = '0x' + 'b'.repeat(130);
const REDACTED = '<redacted:relayer-key>';

describe('OpaqueRelayerKey — redaction paths', () => {
  it('JSON.stringify redacts', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    expect(JSON.stringify(key)).toBe(`"${REDACTED}"`);
  });

  it('toString redacts', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    expect(String(key)).toBe(REDACTED);
    expect(`${key}`).toBe(REDACTED);
  });

  it('util.inspect redacts', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    expect(inspect(key)).toBe(REDACTED);
  });

  it('structuredClone does not expose the secret', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    const cloned = structuredClone({ k: key });
    expect(JSON.stringify(cloned)).not.toContain(RAW_HEX_NO_PREFIX);
  });

  it('key field is non-enumerable', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    expect(Object.keys(key)).toEqual([]);
    const props = Object.getOwnPropertyNames(key);
    for (const p of props) {
      const v = (key as unknown as Record<string, unknown>)[p];
      expect(typeof v === 'string' ? v.includes(RAW_HEX_NO_PREFIX) : false).toBe(false);
    }
  });

  it('rejects empty string in constructor', () => {
    expect(() => new OpaqueRelayerKey('')).toThrow(TypeError);
  });

  it('accepts 0x-prefixed and bare hex inputs', () => {
    const a = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    const b = new OpaqueRelayerKey(RAW_HEX_NO_PREFIX);
    expect(getRelayerKeySecret(a)).toBe(RAW_HEX_WITH_PREFIX);
    expect(getRelayerKeySecret(b)).toBe(RAW_HEX_NO_PREFIX);
  });
});

describe('OpaqueRelayerKey — logger serialization', () => {
  it('pino serialization does not leak', async () => {
    const captured: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString('utf8'));
        cb();
      },
    });
    const logger = pino(sink);
    logger.info({ relayerKey: new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX) }, 'hello');
    await new Promise((r) => setImmediate(r));
    const text = captured.join('');
    expect(text).toContain(REDACTED);
    expect(text).not.toContain(RAW_HEX_NO_PREFIX);
  });

  it('winston serialization does not leak', async () => {
    const captured: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString('utf8'));
        cb();
      },
    });
    const logger = winston.createLogger({
      format: winston.format.json(),
      transports: [new winston.transports.Stream({ stream: sink })],
    });
    logger.info('hello', { relayerKey: new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX) });
    await new Promise((r) => setImmediate(r));
    const text = captured.join('');
    expect(text).toContain(REDACTED);
    expect(text).not.toContain(RAW_HEX_NO_PREFIX);
  });
});

describe('getRelayerKeySecret', () => {
  it('extracts only via the private symbol path', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    expect(getRelayerKeySecret(key)).toBe(RAW_HEX_WITH_PREFIX);
  });

  it('throws when called on a non-OpaqueRelayerKey object', () => {
    const fake = { '<redacted:relayer-key>': true } as unknown as OpaqueRelayerKey;
    expect(() => getRelayerKeySecret(fake)).toThrow(TypeError);
  });

  it('OpaqueRelayerKey.is brand check', () => {
    const key = new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX);
    expect(OpaqueRelayerKey.is(key)).toBe(true);
    expect(OpaqueRelayerKey.is({})).toBe(false);
    expect(OpaqueRelayerKey.is(null)).toBe(false);
    expect(OpaqueRelayerKey.is(undefined)).toBe(false);
    expect(OpaqueRelayerKey.is('a string')).toBe(false);
  });
});

describe('scrubSecrets', () => {
  it('redacts 0x-prefixed 64-hex', () => {
    const input = `key=${RAW_HEX_WITH_PREFIX} trailing`;
    const out = scrubSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(RAW_HEX_NO_PREFIX);
  });

  it('redacts bare 64-hex (word-boundary anchored)', () => {
    const input = `RELAYER_KEY=${RAW_HEX_NO_PREFIX}\n`;
    const out = scrubSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(RAW_HEX_NO_PREFIX);
  });

  it('redacts 0x-prefixed 130-hex (ECDSA sig)', () => {
    const input = `sig=${RAW_SIG_WITH_PREFIX}`;
    const out = scrubSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(RAW_SIG_WITH_PREFIX.slice(2));
  });

  it('redacts OpaqueRelayerKey instances by brand', () => {
    const out = scrubSecrets({ key: new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX) });
    expect(out).toEqual({ key: REDACTED });
  });

  it('walks nested objects and arrays', () => {
    const out = scrubSecrets({
      a: [`before ${RAW_HEX_WITH_PREFIX} after`, { b: new OpaqueRelayerKey(RAW_HEX_WITH_PREFIX) }],
    }) as { a: [string, { b: string }] };
    expect(out.a[0]).toContain(REDACTED);
    expect(out.a[0]).not.toContain(RAW_HEX_NO_PREFIX);
    expect(out.a[1].b).toBe(REDACTED);
  });

  it('handles cyclic structures without overflow', () => {
    interface Cyclic {
      self?: Cyclic;
      v: string;
    }
    const a: Cyclic = { v: RAW_HEX_WITH_PREFIX };
    a.self = a;
    const out = scrubSecrets(a) as Cyclic;
    expect(out.v).toContain(REDACTED);
    expect(out.self).toBeDefined();
    // The cycle back-edge must point at the SCRUBBED copy, not the original
    // object — otherwise `out.self.v` would still hold the raw secret.
    expect(out.self).toBe(out);
    expect(out.self?.v).toContain(REDACTED);
    expect(out.self?.v).not.toContain(RAW_HEX_NO_PREFIX);
    expect(JSON.stringify(out, (_k, v) => (v === out ? '[Circular]' : v))).not.toContain(
      RAW_HEX_NO_PREFIX,
    );
  });

  it('handles cycles through arrays', () => {
    const arr: unknown[] = [RAW_HEX_WITH_PREFIX];
    arr.push(arr);
    const out = scrubSecrets(arr) as unknown[];
    expect(out[0]).toContain(REDACTED);
    expect(out[1]).toBe(out);
  });

  it('preserves shared references (DAG)', () => {
    const shared = { x: RAW_HEX_WITH_PREFIX };
    const root = { a: shared, b: shared };
    const out = scrubSecrets(root) as { a: { x: string }; b: { x: string } };
    expect(out.a).toBe(out.b);
    expect(out.a.x).toContain(REDACTED);
  });

  it('error stacks with inline 0x{64} hex are redacted', () => {
    const err = new Error(`oops; key=${RAW_HEX_WITH_PREFIX}`);
    const scrubbedMsg = scrubSecrets(err.message) as string;
    expect(scrubbedMsg).toContain(REDACTED);
    expect(scrubbedMsg).not.toContain(RAW_HEX_NO_PREFIX);
  });

  it('preserves non-secret strings', () => {
    expect(scrubSecrets('hello world')).toBe('hello world');
  });

  it('preserves non-string scalars', () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets(null)).toBe(null);
    expect(scrubSecrets(true)).toBe(true);
  });
});
