/**
 * OpaqueRelayerKey — defense-in-depth wrapper for the relayer EOA private key.
 *
 * Per tech-spec D13:
 *   - Secret lives in a class-private `#key` field (not in `Object.keys`,
 *     `JSON.stringify`, `Object.getOwnPropertyNames`, or structuredClone).
 *   - All implicit string-conversion paths (`toJSON`, `toString`,
 *     `util.inspect.custom`) return the literal `<redacted:relayer-key>`.
 *   - Extraction is gated through `getRelayerKeySecret(key)` — only
 *     `settle.ts` should import that function.
 *
 * `scrubSecrets` is a recursive scrubber for the security-logger boundary
 * (D18) and the error-formatter boundary. It redacts:
 *   - `0x` + 64 hex characters (raw key with `0x`).
 *   - 64 hex characters word-boundary-anchored (env-var shape).
 *   - `0x` + 130 hex characters (full ECDSA signature with `0x`).
 *   - Any `OpaqueRelayerKey` instance (via internal brand symbol).
 *
 * False positives (e.g. a transaction hash matching the 64-hex pattern) are
 * an accepted trade-off — these patterns run at the SecurityLogger and error
 * boundaries, where false positives are preferable to silent leaks.
 */

import type { OpaqueRelayerKey as OpaqueRelayerKeyShape } from './types.js';

const REDACTED = '<redacted:relayer-key>';
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const BRAND = Symbol.for('@universal-paywall/middleware/OpaqueRelayerKey');

const HEX_64_WITH_PREFIX_RE = /0x[0-9a-fA-F]{64}/g;
const HEX_130_WITH_PREFIX_RE = /0x[0-9a-fA-F]{130}/g;
const HEX_64_BARE_RE = /\b[0-9a-fA-F]{64}\b/gi;

export class OpaqueRelayerKey implements OpaqueRelayerKeyShape {
  // Class-private field — invisible to Object.keys, JSON.stringify, and
  // structuredClone. Constructor accepts inputs with or without the `0x`
  // prefix (env-var habits often omit it); normalization is settle.ts's job.
  readonly #key: string;

  // Brand stamped on the prototype (via the constructor) so `is()` works
  // across realms (Symbol.for is the cross-realm identity key).
  static readonly [BRAND] = true as const;

  constructor(key: string) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('OpaqueRelayerKey: key must be a non-empty string');
    }
    this.#key = key;
    Object.defineProperty(this, BRAND, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return REDACTED;
  }

  static is(x: unknown): x is OpaqueRelayerKey {
    return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[BRAND] === true;
  }

  // Internal extraction path — NOT exported from index.ts; settle.ts uses
  // the `getRelayerKeySecret` wrapper below.
  static _extract(key: OpaqueRelayerKey): string {
    return key.#key;
  }
}

/**
 * Extracts the wrapped relayer key.
 *
 * Only `settle.ts` should import this — the rest of the middleware operates
 * on the opaque wrapper. Throws when called on something that is not an
 * `OpaqueRelayerKey` instance (catches accidental misuse where a plain
 * object slipped through).
 */
export function getRelayerKeySecret(key: OpaqueRelayerKey): string {
  if (!OpaqueRelayerKey.is(key)) {
    throw new TypeError('getRelayerKeySecret: input is not an OpaqueRelayerKey');
  }
  return OpaqueRelayerKey._extract(key);
}

// ─── scrubSecrets ──────────────────────────────────────────────────────────────

function scrubString(s: string): string {
  return s
    .replace(HEX_130_WITH_PREFIX_RE, REDACTED)
    .replace(HEX_64_WITH_PREFIX_RE, REDACTED)
    .replace(HEX_64_BARE_RE, REDACTED);
}

export function scrubSecrets(input: unknown): unknown {
  const seen = new WeakSet<object>();
  function walk(v: unknown): unknown {
    if (typeof v === 'string') return scrubString(v);
    if (v === null || typeof v !== 'object') return v;
    if (OpaqueRelayerKey.is(v)) return REDACTED;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) {
      return v.map((item) => walk(item));
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = walk(val);
    }
    return out;
  }
  return walk(input);
}
