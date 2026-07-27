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
