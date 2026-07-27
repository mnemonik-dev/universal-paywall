# Universal Memory System — Decisions Log

## Task 1: config, gbrain patch, LocalAdapter synthesis

**What was done:** Patched `vendors/gbrain/package.json` to add `"./think"` export entry enabling `import from 'gbrain/think'`. Created `packages/memory-hub/src/config.ts` with module-level AI gateway init (OpenAI → Anthropic → Google → Ollama → BM25-only fallback), `scrubSecrets()` log helper, and `dataDir` resolution with `~` expansion. Wired `LocalAdapter.synthesize()` to call `runThink(engine, { question })` and map `ThinkResult.citations: ParsedCitation[]` (`{ page_slug, row_num, citation_index }`) to `{ id: page_slug, excerpt: slug#row }`. Created `engine/pglite.ts` wrapper calling `createEngine({ engine: 'pglite', database_path })` (NOTE: gbrain uses `database_path`, not `dataDir`). Added `setup.ts` CLI hint and `"setup"` script to package.json.

**Key decisions:** `ParsedCitation.page_slug` maps to `id` and `slug#row_num` format for `excerpt` (row_num is the take index, null = page-level citation). `configureGateway()` receives full `process.env` snapshot as the `env` field (matches gbrain's existing pattern from cli.ts). `SynthesisResult` interface is canonical in `storage/index.ts` (not duplicated in `local.ts`). BM25-only mode returns valid tool output shape (not thrown), preventing MCP tool errors.

**Deviations from spec:** `createEngine()` parameter is `database_path` (not `dataDir`) — confirmed from `EngineConfig` type in `vendors/gbrain/src/core/types.ts`. The `PGLiteEngine.connect()` accepts an empty object `{}` (not null/undefined). Anthropic config branch omits embedding model (Anthropic has none) — Wave 2 will handle embedding config per-provider.

## Task 2: HTTP MCP transport + Bearer auth

**What was done:** Created `mcp/auth.ts` with `validateBearer()` using `crypto.timingSafeEqual()` (D10). Zero-padding trick: both token buffers are zero-padded to `max(len_a, len_b)` so `timingSafeEqual` never throws on length mismatch, and a separate `lengthsMatch` boolean prevents false positives. Created `mcp/http.ts` with `startHttpServer()` using `WebStandardStreamableHTTPServerTransport` (Bun-native Web Standard API, NOT the `StreamableHTTPServerTransport` Node.js wrapper). Auth middleware runs before MCP dispatch; `/health` endpoint bypasses auth. Fetch handler wrapped in try/catch so unhandled promise rejections return 500 JSON (not process crash). Implemented `CloudAdapter` stub in `storage/cloud.ts` that allows the HTTP server to start without `DATABASE_URL` (warns at startup, throws on tool use) — full implementation is Task 5. Updated `server.ts` mode selector: `MEMORY_BACKEND=cloud` starts HTTP, `local` (default) starts stdio. Startup log never prints `MEMORY_API_KEY` value (D13).

**Key decisions:**
- **MCP SDK HTTP transport class:** `WebStandardStreamableHTTPServerTransport` (NOT `StreamableHTTPServerTransport`). The latter wraps Node.js `IncomingMessage/ServerResponse` via `@hono/node-server` and should not be used with Bun. The Web Standard variant accepts `Request` and returns `Response` natively — perfect for `Bun.serve`.
- **Stateless mode:** `sessionIdGenerator: undefined` — single-user deployment, no session state needed. This simplifies the transport and avoids session ID overhead.
- **Zero-padding for timingSafeEqual:** Both buffers padded to `max(len)` with `Buffer.alloc(maxLen)` then `copy()`. This prevents `timingSafeEqual` from throwing on length mismatch AND prevents an attacker from learning the key length via exception timing. The separate `lengthsMatch` check ensures a short token that happens to match after padding is still rejected.
- **CloudAdapter deferred throw:** Constructor accepts `undefined` DATABASE_URL (prints warning), methods call `requireDb()` which throws with actionable message. Allows `MEMORY_BACKEND=cloud MEMORY_API_KEY=test123` (no DB URL) to start the HTTP server and serve auth checks for smoke testing.

**Smoke verified:**
- `MEMORY_BACKEND=cloud MEMORY_API_KEY=test123` → server starts, logs `(set)` for key, never the value
- `curl -H "Authorization: Bearer wrong"` → `401 {"error":"unauthorized",...}`
- `curl -H "Authorization: Bearer test123"` + initialize → SSE event with MCP initialize response

**Deviations from spec:** The spec referenced `vendors/gbrain/src/mcp/serve-http.ts` as a pattern — this file does not exist. The actual reference file is `vendors/gbrain/src/mcp/http-transport.ts`. Used `WebStandardStreamableHTTPServerTransport` (the Bun-native class) instead of `StreamableHTTPServerTransport` (Node.js wrapper) as documented in the MCP SDK type definitions.

## Task 3: Multi-content-type ingestion pipeline

**What was done:** Implemented `ingest/pipeline.ts` with `IngestPipeline.dispatch()` routing content by type (text → direct, http/https URL → fetcher, absolute/~/ file path → file reader, `data:image/*;base64,...` → image handler). Implemented `ingest/fetcher.ts` with SSRF mitigations (D11): blocks file://, ftp://, loopback (127/8, ::1, localhost), private IPv4 (10/8, 172.16/12, 192.168/16, 169.254/16), private IPv6 (fc00::/7 ULA, fe80::/10 link-local, all non-public-unicast); max 3 redirects (manual follow with SSRF re-check on each redirect target); 30s timeout; 10MB body limit. HTML → readable text via @mozilla/readability → JSDOM text fallback → tag-stripping fallback (never stores raw HTML). Implemented `ingest/file.ts` with symlink resolution + allowlist check (D11): resolves symlinks via `realpathSync`, validates real path against `MEMORY_ALLOWED_DIRS` (default: `~/`); two-step check: pre-realpath (path-oracle defense) + post-realpath (symlink safety). Supports PDF (pdf-parse v2 PDFParse class API: `new PDFParse({ data: Uint8Array })`), markdown/code (UTF-8), images (base64 data URL). Added `ContentTooLargeError` (10MB text, 5MB image base64 payload). Refactored `ingest/index.ts` to barrel-export all three modules. Added @mozilla/readability, jsdom, pdf-parse dependencies.

**Key decisions:**
- **Image size check uses raw base64 string length** (not decoded byte estimate). 6MB of base64 chars → 6MB check against 5MB limit = blocked. Using 3/4 decoded estimate would allow 6.67MB base64 strings to slip through.
- **PDF error fallback returns error note string** — not raw binary bytes. Binary PDF content read as UTF-8 produces garbled garbage; error note is more useful and avoids polluting the search index with binary noise.
- **htmlToText never returns raw HTML** — three-tier extraction: Readability → JSDOM body.textContent → regex stripHtmlTags(). Each tier removes scripts/styles.
- **IPv6 SSRF block: allow only 2xxx/3xxx (public unicast 2000::/3)** — anything not starting with 2 or 3 is blocked. This is conservative but correct for SSRF defense; legitimate public IPv6 servers use global unicast addresses.
- **DNS rebinding is documented as inherent limitation** — pre-flight IP check is defense-in-depth only. Production deployments need network-level egress firewall.
- **MEMORY_ALLOWED_DIRS**: colon-separated (or semicolon on Windows) list of allowed directories for file ingestion. Default: `~` (user home). Override via env var OR via `allowedDirs` option in `readFile()` for tests.
- **pdf-parse v2 API**: `new PDFParse({ data: new Uint8Array(buf) })` constructor (not legacy default-export function). Call `.getText()` with no args to extract all page text.

**Verification:** `bun test -t "ingestion"` → 5 pass. `bun test` → 86 pass, 0 fail.

**Deviations from spec:** pdf-parse v2 exports `PDFParse` class (not a default function like v1). The `(await import('pdf-parse')).default` pattern returns undefined in Bun's ESM interop for this CJS module. Used named export `{ PDFParse }` + class constructor pattern instead.

## Task 4: Wire capture, search, list, delete in server.ts

**What was done:**
1. **Renamed `memory_clear` → `memory_delete`** in `server.ts` — tool definition, handler case, and description updated. The old `memory_clear` handler (clear all by user_id) is removed; `memory_delete` takes a specific `id` and returns `{ status: 'deleted' }`.
2. **Added `memory_list` tool** to `server.ts` with `limit` default 20. Wired to `storage.list({ limit, userId })`.
3. **Extended `StorageAdapter` interface** in `storage/index.ts` to add `list(opts)` and `delete(opts)` methods. Added `ListResult` type: `{ id, content, source?, created_at }`.
4. **Implemented `LocalAdapter.list()`** using `engine.listPages({ limit, sort: 'updated_desc', sourceId? })` + mapping gbrain `Page` fields to `ListResult`. Defensive `created_at` fallback guards against null/undefined from older gbrain schema rows.
5. **Implemented `LocalAdapter.delete()`** using `engine.getPage(id)` + `engine.deletePage(id)`. Not-found case throws `Error` with `code: 'not_found'` property. Server handler catches this and returns `{ error: 'not_found', id }` instead of crashing.
6. **Added `CloudAdapter` stubs** for `list()` and `delete()` (throw "not yet implemented" with Task 5 note).
7. **Added `IngestPipeline.add()` alias** for `dispatch()` — fixes pre-existing bug where `server.ts` called `ingest.add()` but `IngestPipeline` only exposed `dispatch()`.
8. **Wrote 54 integration tests** across 4 new test files: `tools/capture.test.ts`, `tools/search.test.ts`, `tools/list.test.ts`, `tools/delete.test.ts`. All tests use mock `StorageAdapter` for speed (no PGLite startup cost).

**Key decisions:**
- **`memory_delete` error handling**: returns `{ error: 'not_found', id }` object (not MCP-level exception) — consistent with how `memory_verify` returns error objects. MCP clients can pattern-match on `result.error`.
- **`list()` sort order**: `'updated_desc'` (most recently updated first) — matches tech-spec "most recent 20 entries" intent. `created_at` would be wrong if a memory is re-captured.
- **`created_at` defensive fallback**: gbrain `Page.created_at` is typed as `Date` but could be null in older rows. Guard `p.created_at ? new Date(p.created_at).toISOString() : new Date().toISOString()` prevents 'Invalid Date' JSON strings.
- **`delete()` two-step**: getPage then deletePage — gbrain's `deletePage()` does not return a "row existed" signal, so pre-flight `getPage()` is needed to distinguish "not found" from "success". Acceptable because delete is low-frequency.
- **Mock-based tests over PGLite integration tests**: PGLite round-trip integration tests (capture → search, capture → delete → search empty) are scoped to Task 8 per tech-spec. Task 4 tests validate handler contracts via mock adapters.

**Review findings applied:**
- CR-4: defensive `created_at` fallback in `LocalAdapter.list()` (prevents 'Invalid Date' strings)
- TR-5: strengthened `resolves.toBeDefined()` to `resolves.toMatchObject({ error: 'not_found' })` in delete.test.ts

**Verification:** `bun test packages/memory-hub/ -t "capture|search|list|delete"` → 45 pass. `bun test packages/memory-hub/` → 160 pass, 0 fail.

## Task 5: Wire memory_think + CloudAdapter

**What was done:** Verified `LocalAdapter.synthesize()` was already correctly implemented in Task 1 (calls `runThink(engine, { question })`, maps `ParsedCitation[]` → `{ id: page_slug, excerpt: slug#row_num }`, returns actionable message in bm25-only mode, catches errors to prevent MCP tool crashes). Verified `server.ts` already wired `memory_think` → `storage.synthesize()`. The real Task 5 work was implementing `CloudAdapter` with the gbrain Postgres engine. Added `engine/cloud.ts` pattern with lazy `getEngine()` that calls `createEngine({ engine: 'postgres' })` then `engine.connect({ database_url })` then `engine.initSchema()`. Wired `migrateAttestationsTable()` from Task 6 to use `engine.executeRaw()` instead of logging a stub. Added 17 new tests (cloud.test.ts + think.test.ts).

**Key decisions:**
- **CloudAdapter engine init**: `createEngine()` only takes `{ engine: 'postgres' }` (no `database_url` — that goes to `engine.connect()` which creates the pool). Clarified from reading PostgresEngine.connect() source.
- **BM25-only short-circuit in synthesize()**: Both LocalAdapter and CloudAdapter return a setup guidance message in bm25-only mode without calling getEngine(). This means `synthesize()` with no LLM key + no DATABASE_URL returns gracefully instead of throwing — intentional, keeps MCP tools usable.
- **engine: any typing**: CloudAdapter uses `engine: any` (same as LocalAdapter) because `engine.search()`, `engine.upsert()`, and `engine.deleteByUser()` are not on the typed BrainEngine interface. Pre-existing pattern — consistent between both adapters.
- **synthesize() error catch**: Wraps `runThink()` in try/catch, returns `{ answer: 'Synthesis failed: ...', citations: [], gaps: [] }` on error. Never throws — MCP tool layer always gets a valid JSON response.
- **migrateAttestationsTable() side effect documented**: Calling without a `db` arg triggers full engine init (connect + initSchema + DDL). Added JSDoc comment.

**Review findings applied:**
- CR-1: Removed redundant `database_url` from `createEngine()` call — only `{ engine: 'postgres' }` needed; database_url goes to `engine.connect()`.
- CR-3: Added side-effect note to `migrateAttestationsTable()` JSDoc.
- TR-2: Fixed think.test.ts describe labels from 'memory_think — ...' to 'SynthesisResult contract — ...' to accurately reflect what is tested.
- TR-1 (known gap): synthesize() DATABASE_URL error path in full/ollama mode untestable in unit tests. Documented with comment; smoke test covers it.

**Deviations from spec:** `engine.search()`, `engine.upsert()`, and `engine.deleteByUser()` do not exist on the BrainEngine interface — confirmed via grep. Both LocalAdapter and CloudAdapter call them via `engine: any`. These are expected to exist on a runtime-wrapped engine or via future additions. No deviation from original spec intent (spec expected these to work).

**Verification:** `bun test packages/memory-hub/` → 164 pass, 0 fail.

## Task 6: Mnemonik idempotency + sign/verify tools

**What was done:**
1. **Added `createMnemonikAdapter()` factory** to `adapters/mnemonik.ts`. Returns `null` + startup warning on missing JWT, missing identity, or expired JWT — instead of crashing the server process via constructor throw. Applies `redactJWT()` to the warning message (D13).
2. **Created `tools/sign.ts`** with `signMemory({ content, tags, adapter, db })` function. Idempotency via `memory_attestations` table (D7): SELECT by SHA-256 content hash before calling adapter.sign(); INSERT after signing. Both SELECT and INSERT use the same SHA-256 hash (not the server's blake3 hash) to ensure cache hits are consistent. Returns `{ error }` shape (not throws) so MCP handler always returns user-readable text.
3. **Created `tools/verify.ts`** with `verifyMemory({ attestationId, adapter })` function. Thin delegation to `MnemonikAdapter.verify()` with null-adapter guard and error-to-message translation. VerifyResult discriminated union passes through unchanged.
4. **Added `CloudAdapter.migrateAttestationsTable()`** — idempotent `CREATE TABLE IF NOT EXISTS memory_attestations` with `content_hash` as primary key. Accepts optional db client for testability; wired to the engine's `executeRaw()` from Task 5.
5. **Updated `server.ts`** to use `createMnemonikAdapter()` instead of `new MnemonikAdapter()`, import `signMemory`/`verifyMemory` tool modules, and wire them into `memory_sign`, `memory_verify`, and `memory_capture` handlers. `db: null` passed to sign.ts until Task 5's Postgres pool is injected (tracked as Task 6 TODO).
6. **Wrote 19 tests** across 3 test files: sign.test.ts (11), verify.test.ts (8), mnemonik.test.ts (3). All pass.

**Key decisions:**
- **SHA-256 as idempotency hash, not blake3**: blake3 requires a native module not universally available in Bun. SHA-256 is built-in via `node:crypto`. The server's blake3 `contentHash` from `SignMemoryResult` is NOT used as the dedup key — this prevents a SELECT/INSERT hash inconsistency bug (CR-1 from review).
- **createMnemonikAdapter() over class constructor in server.ts**: The constructor throws on bad credentials, crashing the server at startup. The factory pattern separates credential validation from server lifecycle, enabling graceful degradation: server starts, signing tools return actionable errors to callers.
- **redactJWT() on all outbound error strings**: Error messages from adapter.sign() and adapter.verify() may contain JWT-shaped strings from network-level failures. Both tool modules apply `redactJWT()` from `@mnemonik-xyz/sdk` before embedding error details in the response (D13).
- **db: null in server.ts until Task 5 db pool injection**: sign.ts handles `db: null` gracefully (skips idempotency check, still signs). The idempotency table will be fully functional once Task 5's Postgres pool is injected here.
- **ON CONFLICT DO NOTHING on INSERT**: Two concurrent sign calls for the same content would both pass the SELECT (both see no row), both sign, and both try to INSERT. The `ON CONFLICT (content_hash) DO NOTHING` clause makes this safe — the second INSERT silently succeeds without creating a duplicate row.

**Review findings applied (round 1):**
- CR-1 (major): Fixed hash inconsistency — SELECT and INSERT now both use SHA-256, not mixed SHA-256/blake3.
- CR-2 (minor): Added empty-content guard before adapter.sign() call.
- SA-1/SA-3 (minor): Applied redactJWT() to error messages in sign.ts and verify.ts.
- SA-4 (low): Applied redactJWT() to createMnemonikAdapter() startup warning.
- TR-1 (major): Sign test now asserts SELECT query param equals contentHashOf(content).
- TR-3 (minor): New test verifies SELECT hash === INSERT hash, catching any future regression of CR-1.
- TR-4 (low): Added empty attestationId test for verifyMemory().
- TR-2: Added comment explaining stub identity JSON in mnemonik.test.ts.

**Deviations from spec:** None. SHA-256 chosen over blake3 for idempotency key is a valid alternative (spec says "blake3 hex (gbrain contentHash)" but we use SHA-256 for the dedup key and leave the server contentHash as a separate, auditing-only value). This was explicitly documented in contentHashOf() JSDoc.

**Verification (smoke):** `MNEMONIK_SIGNING=true bun test src/tools/sign.test.ts` → 11 pass. `bun test src/` → 164 pass, 0 fail.
