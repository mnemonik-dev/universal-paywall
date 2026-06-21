/**
 * NonceStore — in-memory replay protection store.
 *
 * Single-process scope. Multi-instance support (Redis-backed) is post-MVP —
 * see decisions.md D5.
 *
 * Storage shape: `Map<from, Map<nonce, validBefore>>`. Both `from` (the EOA
 * address) and `nonce` (the 32-byte EIP-3009 nonce) are normalized to
 * lowercase on every public-API boundary so case variations from clients
 * (mixed-case checksums, env-var quirks) cannot mask a replay.
 *
 * The internal time unit is **milliseconds**, matching `verify.ts`'s
 * `validBefore > now + 5_000ms` safety-margin check.
 *
 * `checkAndInsert` is the canonical caller surface for `verify.ts`: it runs
 * has + insert as a single synchronous block — no `await` between the two,
 * so there is no TOCTOU window. `has` / `insert` / `size` are exposed for
 * tests.
 *
 * Capacity:
 *   - Default hard cap of 100,000 entries summed across all inner maps.
 *   - On overflow, evict by oldest `validBefore` (single O(n) scan); 100k
 *     is the absolute ceiling, not a hot path.
 *   - TTL eviction is per-`from` lazy on lookup — keeps the hot path O(k)
 *     per developer.
 *
 * Retention-on-failure: entries are NOT removed when settlement fails
 * (per D5 Risks row). Retries with the same nonce surface
 * `nonce_already_used` rather than re-attempting settle.
 */

const DEFAULT_MAX_ENTRIES = 100_000;

export interface CheckAndInsertInput {
  from: `0x${string}`;
  nonce: `0x${string}`;
  validBefore: number;
  now: number;
}

export interface HasInput {
  from: `0x${string}`;
  nonce: `0x${string}`;
  now: number;
}

export interface InsertInput {
  from: `0x${string}`;
  nonce: `0x${string}`;
  validBefore: number;
}

export type CheckAndInsertResult =
  | { accepted: true }
  | { accepted: false; reason: 'nonce_already_used' | 'authorization_expired' };

export interface NonceStoreOptions {
  maxEntries?: number;
}

export class NonceStore {
  readonly #store: Map<string, Map<string, number>> = new Map();
  #count = 0;
  readonly #maxEntries: number;

  constructor(opts: NonceStoreOptions = {}) {
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  size(): number {
    return this.#count;
  }

  has(input: HasInput): boolean {
    const from = input.from.toLowerCase();
    const nonce = input.nonce.toLowerCase();
    this.#evictExpired(from, input.now);
    const inner = this.#store.get(from);
    return inner !== undefined && inner.has(nonce);
  }

  /**
   * Test-only primitive. Production callers use {@link checkAndInsert}
   * because that path is what enforces the synchronous-block TOCTOU
   * contract AND runs lazy TTL eviction on the per-`from` map. `insert`
   * does NOT receive `now`, so it cannot lazy-evict and `size()` may
   * include stale entries until a subsequent `has`/`checkAndInsert` walk
   * sweeps them. Tests should drive `checkAndInsert` to exercise
   * production semantics.
   */
  insert(input: InsertInput): void {
    const from = input.from.toLowerCase();
    const nonce = input.nonce.toLowerCase();
    let inner = this.#store.get(from);
    if (inner === undefined) {
      inner = new Map();
      this.#store.set(from, inner);
    }
    if (!inner.has(nonce)) {
      this.#ensureCapacity();
      this.#count++;
    }
    inner.set(nonce, input.validBefore);
  }

  checkAndInsert(input: CheckAndInsertInput): CheckAndInsertResult {
    const from = input.from.toLowerCase();
    const nonce = input.nonce.toLowerCase();
    this.#evictExpired(from, input.now);

    // Safety-net: if the caller hasn't already enforced the
    // `validBefore > now + 5_000ms` margin from verify.ts step 7c, refuse
    // the entry here too — never insert an already-dead authorization.
    if (input.validBefore <= input.now) {
      return { accepted: false, reason: 'authorization_expired' };
    }

    const inner = this.#store.get(from);
    if (inner !== undefined && inner.has(nonce)) {
      return { accepted: false, reason: 'nonce_already_used' };
    }

    this.#ensureCapacity();
    let target = inner;
    if (target === undefined) {
      target = new Map();
      this.#store.set(from, target);
    }
    target.set(nonce, input.validBefore);
    this.#count++;
    return { accepted: true };
  }

  // ─── private ─────────────────────────────────────────────────────────────────

  #evictExpired(from: string, now: number): void {
    const inner = this.#store.get(from);
    if (inner === undefined) return;
    for (const [nonce, validBefore] of inner) {
      if (validBefore <= now) {
        inner.delete(nonce);
        this.#count--;
      }
    }
    if (inner.size === 0) {
      this.#store.delete(from);
    }
  }

  #ensureCapacity(): void {
    while (this.#count >= this.#maxEntries) {
      this.#evictOldest();
    }
  }

  #evictOldest(): void {
    let oldestFrom: string | undefined;
    let oldestNonce: string | undefined;
    let oldestValidBefore = Number.POSITIVE_INFINITY;
    for (const [from, inner] of this.#store) {
      for (const [nonce, validBefore] of inner) {
        if (validBefore < oldestValidBefore) {
          oldestValidBefore = validBefore;
          oldestFrom = from;
          oldestNonce = nonce;
        }
      }
    }
    if (oldestFrom !== undefined && oldestNonce !== undefined) {
      const inner = this.#store.get(oldestFrom);
      if (inner !== undefined) {
        inner.delete(oldestNonce);
        this.#count--;
        if (inner.size === 0) {
          this.#store.delete(oldestFrom);
        }
      }
    }
  }
}
