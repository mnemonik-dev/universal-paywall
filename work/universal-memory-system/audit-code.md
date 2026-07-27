# Code Audit — Universal Memory System
**Auditor:** code-auditor (Task 10)
**Date:** 2026-07-27
**Scope:** `packages/memory-hub/src/` (all .ts), `packages/eval/` (all .py)

---

## Summary

Overall the codebase is clean, intentional, and well-documented. Security decisions are consistently applied (timingSafeEqual auth, SSRF mitigations, JWT redaction, secret scrubbing). Error handling is defensive throughout — no silent swallows in hot paths. The issues below are genuine gaps, not style preferences.

---

## Critical Issues

### CRIT-1: `HybridAdapter` referenced but does not exist (runtime crash on `MEMORY_BACKEND=hybrid`)

**File:** `src/storage/index.ts` lines 54–59

`StorageFactory.create()` has a `case "hybrid"` branch that attempts `import("./hybrid.js")` and destructures `HybridAdapter`. No `hybrid.ts` file exists anywhere in `src/storage/`. Any process started with `MEMORY_BACKEND=hybrid` — or an AI client that passes `backend: "hybrid"` — will crash with a module-not-found error at the dynamic import site.

Additionally, `memory_sync` in `server.ts` is registered as an exposed MCP tool (lines 135–144), which implies the hybrid/sync path should be functional. Right now calling `memory_sync` on a `local` adapter silently returns `{ pushed: 0 }` without indicating the feature is unavailable; calling it on a `cloud` adapter calls `requireDb()` then returns `{ pushed: 0 }`. Neither is wrong by itself, but the `hybrid` backend advertised in `StorageConfig` and the `memory_sync` tool together set expectations that a core feature is implemented when it is not.

**Recommended fix:** Either remove `case "hybrid"` from `StorageFactory` (and remove `"hybrid"` from `StorageConfig.backend` union type), or add a `hybrid.ts` stub that throws `"Not yet implemented"` consistently with the `CloudAdapter` stub pattern. Remove or stub `memory_sync` tool definition if the feature is not ready.

---

### CRIT-2: `db: null` in production `memory_sign` / `memory_capture` handlers — idempotency silently disabled

**File:** `src/mcp/server.ts` lines 166 and 208

Both `memory_capture` (when `sign: true`) and `memory_sign` pass `db: null` to `signMemory()`. The comment says "Task 5 will inject db client" — but Task 5 is complete per `decisions.md`. The db client from the Postgres engine is never wired into these handlers.

The consequence: every call to `memory_sign` on the same content creates a new network call to the Mnemonik service and does NOT de-duplicate via the `memory_attestations` table. The idempotency feature documented as D7 is implemented in `sign.ts` but bypassed in `server.ts`. In `cloud` mode with a live Postgres database this is a billing and consistency bug: the same content can accumulate multiple attestations on Arweave/Solana.

`signMemory()` gracefully handles `db: null` (skips the check), so there is no crash — the failure is silent.

**Recommended fix:** After `StorageFactory.create()` returns the `CloudAdapter`, extract its db client and pass it to `signMemory()`. Or add a `getDb()` method to `StorageAdapter` that returns the underlying client (null for LocalAdapter). This is the "Task 5 TODO" that was left open.

---

## Should-Fix Issues

### SF-1: Inconsistent `created_at` null-guard between `LocalAdapter` and `CloudAdapter`

**Files:** `src/storage/local.ts` line 104–106 vs `src/storage/cloud.ts` line 199

`LocalAdapter.list()` has a defensive null-guard: if `p.created_at` is falsy it falls back to `new Date().toISOString()`. `CloudAdapter.list()` does NOT have this guard — it calls `new Date(p.created_at).toISOString()` unconditionally, which produces `"Invalid Date"` if `p.created_at` is null (possible in older schema rows as noted in `decisions.md`). The same bug that was fixed for LocalAdapter was not applied to CloudAdapter.

**Fix:** Apply the same guard to `CloudAdapter.list()`:
```ts
created_at: p.created_at
  ? (p.created_at instanceof Date ? p.created_at : new Date(p.created_at)).toISOString()
  : new Date().toISOString(),
```

---

### SF-2: `probeOllama` duplicated between `config.ts` and `setup.ts`

**Files:** `src/config.ts` lines 87–96, `src/setup.ts` lines 13–22

Identical function with the same logic (fetch `/api/tags`, 2s timeout, return `res.ok || res.status < 500`). The only difference is `setup.ts` reads `OLLAMA_BASE` from a module-level const rather than a parameter. If the SSRF check behavior or timeout changes in one place it will silently diverge from the other.

**Fix:** Export `probeOllama(baseUrl: string)` from `config.ts` and import it in `setup.ts`. Saves ~10 lines and keeps the probe logic in one place.

---

### SF-3: `ipv6HasPrefix` is fragile and partially redundant

**File:** `src/ingest/fetcher.ts` lines 72–84

`ipv6HasPrefix()` handles compressed IPv6 (`::1`) by stripping colons and comparing hex prefixes, but it only works for non-elided addresses. For `fc::1` (a valid ULA address with elision) the function strips colons to `fc1`, which has length 3, but the `hexCharsNeeded` for the `/7` check is `ceil(7/4) = 2`, so `rawCompact.slice(0,2)` is `fc` — this works. However the function is called redundantly: right after it, `bare.startsWith("fc")` and `bare.startsWith("fd")` are checked without any function call, making `ipv6HasPrefix` in that branch dead code. The only purpose it serves is the `fc00::/7` bit-exact check for addresses starting with neither `fc` nor `fd` (which do not exist in practice for ULA).

More importantly: the function does not handle the `::` elision case for addresses like `::ffff:10.0.0.1` (IPv4-mapped IPv6), which is not blocked by any of the IPv6 rules and would pass through to a network call resolving to a private IPv4 address.

**Fix:** Either remove `ipv6HasPrefix` (the explicit `startsWith` checks are sufficient) or add an explicit block for IPv4-mapped IPv6 (`::ffff:` prefix covers `::ffff:10.x`, `::ffff:192.168.x`, etc.).

---

### SF-4: `_McpStdioClient._recv_line` is O(n) byte-by-byte reading

**File:** `packages/eval/adapters/universal_memory.py` lines 104–130

The `_recv_line` method reads one byte at a time from stdout. For large MCP responses (e.g., a `memory_search` returning 10 results with long content), this creates thousands of syscalls. For the eval harness running hundreds of QA pairs this compounds significantly. Python's buffered IO (`readline()`) is the natural fix and does not require select because the timeout is wall-clock, not per-byte.

**Fix:** Replace the byte-by-byte loop with `readline()` plus a separate watchdog thread for timeout/process-exit detection, or use `asyncio.subprocess` with proper stream reading. A simpler fix that preserves the existing structure: use `os.read()` with a larger buffer size and accumulate.

---

### SF-5: `run.py` accesses `service._client` directly (breaks encapsulation)

**File:** `packages/eval/run.py` line 302

`run_eval()` calls `service._client.search(question, top_k=top_k)` directly, bypassing `UniversalMemoryService.get_relevant_memories()`. This means the eval loop uses raw search results without the user-isolation tag filtering that `get_relevant_memories()` applies. This is the correct behavior for RecallAccuracy@5 (we want unscoped results to check recall), but it leaks implementation details of `UniversalMemoryService` into the harness. If `_client` is refactored or renamed the harness silently breaks.

**Fix:** Add a public `search_raw(query, top_k)` method to `UniversalMemoryService` that delegates to `self._client.search()`, and call that from `run_eval()`. Keep `get_relevant_memories()` for the prompt-formatted path.

---

### SF-6: `StorageAdapter.clear()` is in the interface but has no MCP tool

**File:** `src/storage/index.ts` line 35

`StorageAdapter` declares `clear(opts: { userId: string }): Promise<void>`. Both `LocalAdapter` and `CloudAdapter` implement it. But no MCP tool exposes `clear` to callers. This means it is dead interface surface — any caller that uses it must access the adapter directly (breaking the abstraction). If it is kept it should be documented as internal-only; if it should be accessible it needs a `memory_clear` tool.

**Fix:** Either add a `// Internal: not exposed as MCP tool` JSDoc comment to the interface, or remove it and replace with direct engine calls at the use sites (currently none — the only callers are tests).

---

## Suggestions

### SUG-1: `mode` export from `config.ts` is a snapshot, not reactive

`export const mode: Mode = _resolvedConfig.mode` captures the mode at module init. If `_resolvedConfig` is mutated after init (e.g., in tests via `(cfg as any).mode = "tampered"`), the exported `mode` const remains stale. Currently this is tested defensively (`config.extra.test.ts` line 126), but it means code using `import { mode } from '../config.js'` will get the snapshot value and code using `getConfig().mode` will get the current value. The two APIs are inconsistent.

**Suggestion:** Deprecate the `mode` export and standardize on `getConfig().mode`. Or make `mode` a getter: `export const getMode = () => _resolvedConfig.mode`.

---

### SUG-2: `LocalAdapter` constructor accepts both `gitDir` and `dataDir` with silent fallback

**File:** `src/storage/local.ts` lines 16–19

The constructor comment says "Accept either gitDir (legacy name) or dataDir (new name from config)" and falls back to `process.env.HOME + "/.universal-memory/brain"` if neither is provided. `StorageFactory.create()` always passes `{ gitDir: config.gitDir }` (line 50) — never `dataDir`. This means the factory always uses the legacy parameter name, and `config.dataDir` (from `config.ts`) is never injected here.

The server's resolved `dataDir` (with `~` expanded correctly) is not used — the LocalAdapter uses whatever `gitDir` it receives, which in practice comes from `MEMORY_GIT_DIR` env var if set, otherwise falls back to the HOME-based string which does NOT go through `config.ts`'s `resolveDataDir()` expansion logic.

**Suggestion:** Pass `dataDir` from `config.ts` through `StorageFactory` to `LocalAdapter`. Update the factory call: `return new LocalAdapter({ dataDir: config.gitDir ?? dataDir })` importing `dataDir` from config. Remove the fallback `process.env.HOME` concatenation from the constructor.

---

### SUG-3: IPv6 SSRF block logs hostname with brackets for some paths

**File:** `src/ingest/fetcher.ts` lines 113–134

The variable `hostname` from `url.hostname` already has brackets stripped by the URL parser for bracketed IPv6 addresses like `[::1]`. However several error messages use `${hostname}` which would show unbracketed `::1`. The `bare` variable (line 115) is the one with explicit bracket stripping. This is cosmetic but can confuse log readers.

**Suggestion:** Use `bare` in all IPv6 error messages inside the `isIpv6` block.

---

### SUG-4: `_answer_quality` stop-word list in `run.py` is English-only

**File:** `packages/eval/run.py` lines 140–141

The stop word set `{"the", "a", "an", "is", "was", "i", "my", "me", "to", "of", "in", "and"}` is hardcoded for English. The RUMBA dataset includes Russian samples (`lan == "ru"`) and the harness calls this function on both. Russian QA pairs have no meaningful stop words removed, so `answer_tokens` will include Russian function words and the `ratio` will be lower than it should be, artificially deflating AnswerQuality for Russian samples.

**Suggestion:** Add a Russian stop-word set (or at minimum document this as English-only and skip the metric for `lan == "ru"` samples). This does not affect the current EN evaluation baseline but will matter for multilingual runs.

---

### SUG-5: `MnemonikAdapter.sign()` passes `as any` to bypass SDK types

**File:** `src/adapters/mnemonik.ts` line 69

```ts
return this.client.signMemory(content, { tags, mode: this.mode } as any);
```

The `as any` cast is used because the options type from `@mnemonik-xyz/sdk` may not include `mode` in its public typings. If the SDK updates and renames this field the cast will silence a compile-time error and the failure will only manifest at runtime.

**Suggestion:** Define a local `SignOptions` interface or check what the SDK actually exports and type the call correctly. If the SDK intentionally omits `mode` from its public API, document why the cast is needed.

---

### SUG-6: Chunk sequential writes in `IngestPipeline.dispatch()` are not parallelized

**File:** `src/ingest/pipeline.ts` lines 196–205

When a document is split into N chunks, each `storage.add()` call is awaited sequentially. For large documents (e.g., a 10MB text file splitting into ~5000 chunks) this is a sequential waterfall of DB upserts. For `LocalAdapter` (single-process PGLite) sequential is fine, but for `CloudAdapter` (Postgres) parallel inserts would significantly reduce latency.

**Suggestion:** Use `Promise.all(chunks.map(...))` or a bounded concurrency pool (e.g., batches of 20) for `CloudAdapter`. This is a future-optimization note, not a blocking issue for current scale.
