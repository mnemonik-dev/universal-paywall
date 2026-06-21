/**
 * OpaqueRelayerKey — defense-in-depth wrapper for the relayer EOA private key.
 *
 * Per tech-spec D13:
 *   - Secret lives in a module-private `WeakMap<OpaqueRelayerKey, string>`
 *     (declared at the SECRET_TABLE binding below), reachable only via
 *     `getRelayerKeySecret(key)`. The class instance carries only a
 *     non-enumerable brand symbol — no member of the class, public or
 *     otherwise, holds the secret. This is strictly stronger than a
 *     class-private `#key` field: a `#` field is still observable via
 *     `Object.getOwnPropertyNames(Object.getPrototypeOf(...))` in some
 *     runtimes and is reachable through a leaked-this reference; the
 *     WeakMap is not.
 *   - All implicit string-conversion paths (`toJSON`, `toString`,
 *     `util.inspect.custom`) return the literal `<redacted:relayer-key>`.
 *   - Extraction is gated through `getRelayerKeySecret(key)` — only
 *     `settle.ts` should import that function. The symbol is NOT
 *     re-exported from `index.ts`.
 *
 * `scrubSecrets` is a recursive scrubber for the security-logger boundary
 * (D18) and the error-formatter boundary. It redacts:
 *   - `0x` + 64 hex characters (raw key with `0x`).
 *   - `0x` + 130 hex characters (full ECDSA signature with `0x`).
 *   - Any maximal bare-hex run of 64 or more characters (env-var keys, raw
 *     signatures without `0x` prefix, and concatenated runs that splice
 *     multiple secrets together without a word boundary).
 *   - Any `OpaqueRelayerKey` instance (via internal brand symbol).
 *
 * False positives (e.g. a transaction hash matching the 64-hex pattern) are
 * an accepted trade-off — these patterns run at the SecurityLogger and error
 * boundaries, where false positives are preferable to silent leaks. The
 * `core.ts` emit helper pre-extracts the `txHash` field as a known-safe
 * carve-out so forensic correlation is preserved (SEC-T8-02).
 */

import type { OpaqueRelayerKey as OpaqueRelayerKeyShape } from './types.js';

const REDACTED = '<redacted:relayer-key>';
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const BRAND = Symbol.for('@universal-paywall/middleware/OpaqueRelayerKey');

const HEX_64_WITH_PREFIX_RE = /0x[0-9a-fA-F]{64}/g;
const HEX_130_WITH_PREFIX_RE = /0x[0-9a-fA-F]{130}/g;
// T13-M-MW-01: collapse any bare-hex run of >=64 chars into the redaction.
// `\b...\b` word boundaries do NOT fire between two adjacent hex characters
// (hex digits are word characters), so the previous bare-64 pattern would
// pass a 128-char concatenated run (two spliced keys, or a 65-byte signature
// emitted without 0x) unredacted. By matching the entire maximal run
// (length >= 64), any embedded 64-/130-hex window is consumed in one shot.
// The anchors are non-hex-or-string-edge on both sides; the 64-char floor
// keeps the false-positive rate low (a 32-byte tx hash without 0x prefix
// would still match — that is an accepted false-positive, mirroring the
// existing bare-64 behaviour).
const HEX_BARE_RUN_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;

// Module-private secret table. The class instance carries only the brand
// marker; the actual key string lives in this WeakMap, which is reachable
// only through the `getRelayerKeySecret` function below. No class member —
// public, protected, or otherwise — can extract the key, so callers cannot
// bypass the brand-check by calling something like `OpaqueRelayerKey._extract`.
const SECRET_TABLE = new WeakMap<OpaqueRelayerKey, string>();

export class OpaqueRelayerKey implements OpaqueRelayerKeyShape {
  constructor(key: string) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('OpaqueRelayerKey: key must be a non-empty string');
    }
    // Constructor accepts inputs with or without the `0x` prefix (env-var
    // habits often omit it); normalization is settle.ts's job.
    SECRET_TABLE.set(this, key);
    // Brand stamped on the instance so `is()` works across realms
    // (Symbol.for is the cross-realm identity key).
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
}

/**
 * Extracts the wrapped relayer key.
 *
 * Only `settle.ts` should import this — the rest of the middleware operates
 * on the opaque wrapper, and this symbol is NOT re-exported from
 * `index.ts`, so it does not appear on the package's public npm API
 * surface. Throws when called on something that is not an
 * `OpaqueRelayerKey` instance (catches accidental misuse where a plain
 * object slipped through).
 */
export function getRelayerKeySecret(key: OpaqueRelayerKey): string {
  if (!OpaqueRelayerKey.is(key)) {
    throw new TypeError('getRelayerKeySecret: input is not an OpaqueRelayerKey');
  }
  const secret = SECRET_TABLE.get(key);
  if (secret === undefined) {
    throw new TypeError('getRelayerKeySecret: instance has no associated secret');
  }
  return secret;
}

// ─── scrubSecrets ──────────────────────────────────────────────────────────────

function scrubString(s: string): string {
  return s
    .replace(HEX_130_WITH_PREFIX_RE, REDACTED)
    .replace(HEX_64_WITH_PREFIX_RE, REDACTED)
    .replace(HEX_BARE_RUN_RE, REDACTED);
}

/**
 * Recursive scrubber. Walks the input graph, producing a fresh copy with all
 * secret-shaped strings and OpaqueRelayerKey instances replaced by the
 * redacted literal. Handles cycles correctly: each input reference is mapped
 * to its scrubbed-copy reference BEFORE its children are walked, so a
 * back-edge that closes a cycle resolves to the (partially-built) scrubbed
 * copy — not the original un-walked object. Without this, a back-edge
 * leaks the raw secret through a cycle (cf. `{ v: SECRET, self: <-self }`).
 */
export function scrubSecrets(input: unknown): unknown {
  const seen = new Map<object, unknown>();
  function walk(v: unknown): unknown {
    if (typeof v === 'string') return scrubString(v);
    if (v === null || typeof v !== 'object') return v;
    if (OpaqueRelayerKey.is(v)) return REDACTED;
    const cached = seen.get(v);
    if (cached !== undefined) return cached;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v, out);
      for (const item of v) {
        out.push(walk(item));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(v, out);
    for (const [k, val] of Object.entries(v)) {
      out[k] = walk(val);
    }
    return out;
  }
  return walk(input);
}
