---
feature: universal-memory-system
created: 2026-07-27
updated: 2026-07-27
status: draft
size: L
branch: dev
---

# Tech Spec: Universal Memory System

## Solution

Build a **single MCP server** (`@universal-memory/hub`) that exposes 7 tools for capturing, searching, synthesizing, signing, and managing a personal AI knowledge base. The server wraps **gbrain as a library** (not running gbrain's own MCP server) and adds an optional **Mnemonik signing layer**.

Two deployment modes share the same tool interface:

1. **Local (stdio)** — gbrain + PGLite (embedded Postgres via WASM, `@electric-sql/pglite`). Zero server setup, zero admin rights. Data in `~/.universal-memory/brain/`. Starts in 2 seconds. No signing available.

2. **Cloud (HTTP MCP)** — gbrain + Postgres (pgvector). Docker Compose service on Hetzner VPS. HTTPS via nginx + Let's Encrypt. Single API key in `Authorization: Bearer` header. All 7 tools including `memory_sign` and `memory_verify`.

gbrain provides: hybrid search (vector + BM25 + RRF via `hybridSearch()`), synthesis via standalone `runThink(engine, opts)` function from `gbrain/think` (NOT a BrainEngine method), knowledge graph, chunking, embedding. Its AI gateway (`gbrain/core/ai/gateway`) supports OpenAI, Anthropic, Google, and OpenAI-compatible providers — configured via `configureGateway()` at startup. Requires **Bun ≥1.3.10** (PGLite WASM is Bun-specific); Node.js not supported.

The Mnemonik signing layer (`@mnemonik-xyz/sdk`) is an **optional cloud-only addon** — `MnemonicClient.signMemory()` adds Ed25519 COSE_Sign1 attestation; `MnemonicClient.verify()` checks it. Enabled by `MNEMONIK_SIGNING=true` env var.

**Repository:** `/home/op/Projects/universal-memory/` (exists, submodules `vendors/gbrain` + `vendors/mnemonik` added, scaffolding exists in `packages/memory-hub/` — all requires rewrite/completion).

## Architecture

### What we're building/modifying

```
packages/memory-hub/
  src/
    config.ts                  # env-driven config, configureGateway() call
    engine/
      factory.ts               # createEngine(mode) → BrainEngine
      pglite.ts                # PGLite engine init (local mode)
      postgres.ts              # Postgres+pgvector engine init (cloud mode)
    ingest/
      pipeline.ts              # IngestPipeline: dispatch by content type
      fetcher.ts               # URL → markdown (fetch + readability)
      file.ts                  # file path → content (PDF, md, code, image)
    tools/
      capture.ts               # memory_capture handler
      search.ts                # memory_search handler
      think.ts                 # memory_think handler
      sign.ts                  # memory_sign handler
      verify.ts                # memory_verify handler
      list.ts                  # memory_list handler
      delete.ts                # memory_delete handler
    mcp/
      server.ts                # MCP Server wiring (stdio + HTTP modes)
      http.ts                  # HTTP MCP transport (Bun.serve + SSE)
      auth.ts                  # Bearer token middleware for HTTP mode
    adapters/
      mnemonik.ts              # MnemonicClient wrapper (already exists, rewrite)
  package.json
  tsconfig.json

docker/
  memory-hub/
    Dockerfile                 # Bun + memory-hub
nginx/
  memory.conf                  # /memory.yourdomain.com → memory-hub:3456

docker-compose.yml             # add memory-hub + postgres services
.env.example                   # new env vars
```

### How it works

**Local mode (stdio):**
```
MCP client (Claude Code / KimiClaw / Kini)
  → stdio → MCP SDK StdioServerTransport
  → MCP Server (tools/list + tools/call dispatch)
  → tool handler → gbrain PGLite engine
  → ~/.universal-memory/brain/ (PGLite data dir)
```

**Cloud mode (HTTP MCP):**
```
MCP client (any device, any client)
  → HTTPS → nginx (TLS termination + Bearer check → 401 if missing/wrong)
  → Bun.serve HTTP server (SSE + MCP HTTP transport)
  → MCP Server → tool handler → gbrain Postgres engine
  → Postgres + pgvector (Docker service)
  → (optional) Mnemonik MCP HTTP → memory_sign/verify
```

**memory_capture flow:**
```
1. Tool call: { content, source?, tags? }
2. IngestPipeline.dispatch():
   - string → direct text
   - URL (http/https) → fetcher.fetch() → markdown
   - file path → file.read() → content + mime type
   - base64 image → image embedding via gbrain AI gateway
3. gbrain engine.upsertPage(pageInput) → chunk + embed + store
4. Returns: { id, chunks }
```

**memory_search flow:**
```
1. Tool call: { query, top_k? }
2. engine.search({ query, limit: top_k, hybrid: true })
   → gbrain hybrid: vector similarity (pgvector HNSW) + BM25 (pg_trgm FTS) + RRF fusion
3. Returns: [{ id, content, score, source, tags }]
```

**memory_think flow:**
```
1. Tool call: { question }
2. runThink(engine, { question }) — imported from vendors/gbrain/src/core/think/index.ts
   via direct path (gbrain package.json has no ./think export — Wave 1 Task 1 patches it)
   → internally: runGather(engine, question) → SearchResult[] + TakeHit[]
   → LLM call via gbrain AI gateway → synthesized answer + citations + gaps
3. Returns: { answer, citations: [{id, excerpt}], gaps }
   (ThinkResponse.citations map to ParsedCitation[] — slugs to page ids)
```

**memory_sign flow (cloud only):**
```
1. Tool call: { id, tags? }
2. engine.getPage(id) → retrieve content
3. MnemonicClient.signMemory(content, { tags }) → COSE_Sign1 Ed25519
   → deferred pending-bundle flow: server returns correlation_id
   → SDK fetches canonical CBOR, signs locally, POSTs envelope back
4. Returns: { attestationId, signedAt, status }
```

### Shared resources

| Resource | Owner | Consumers | Instance count |
|---|---|---|---|
| `BrainEngine` (PGLite or Postgres) | `engine/factory.ts` (lazy init on first request) | all tool handlers | 1 per process |
| gbrain AI gateway (embedding + LLM) | `config.ts` via `configureGateway()` | capture (embed), think (generate), search (query expand) | 1 per process (singleton in gbrain) |
| `MnemonicClient` | `adapters/mnemonik.ts` (lazy init) | sign.ts, verify.ts | 1 per process, cloud-only |
| Postgres connection pool | `engine/postgres.ts` | BrainEngine | 1 pool per process |
| API key (env var `MEMORY_API_KEY`) | `mcp/auth.ts` | HTTP requests only | read-only constant |

## Decisions

### D1: gbrain as library, not as subprocess

**Decision:** Import gbrain modules directly (`gbrain/pglite-engine`, `gbrain/engine`, `gbrain/search/hybrid`, `gbrain/ingestion`) as a library, not via spawning gbrain's own MCP server.

**Rationale:** Supports user-spec requirement for a unified MCP server with 7 custom tools. Running gbrain's own MCP server (67 tools, opinionated naming) and proxying would add a subprocess boundary, complicate auth, and expose tools irrelevant to this use case. Library import gives direct control over tool definitions while leveraging gbrain's storage/search/synthesis internals. Supports US requirement "легко встраивается в сторонние приложения".

**Alternatives considered:** Proxy gbrain's MCP server and add memory_sign/memory_verify on top — rejected, creates two MCP servers + subprocess management + port conflicts.

### D2: Bun runtime (required by gbrain)

**Decision:** Runtime is **Bun ≥1.3.10**. Not Node.js.

**Rationale:** [TECHNICAL] gbrain uses Bun-specific APIs (Bun.file, Bun.serve, `@electric-sql/pglite` with Bun-compatible WASM loading). PGLite WASM initialization in gbrain's codebase assumes Bun's module resolver. Node.js compatibility cannot be guaranteed without patching gbrain's internals, which we don't own. Bun installs to `~/.bun/` without admin rights — satisfies user-spec zero-admin constraint.

**Alternatives considered:** Node.js + compatibility shims — rejected, risks breaking PGLite WASM loading and gbrain's internal Bun.file calls.

### D3: MCP HTTP transport via SSE (Streamable HTTP)

**Decision:** Cloud mode uses MCP's Streamable HTTP transport (SSE-based), implemented via `Bun.serve`. Port 3456 internally, exposed via nginx HTTPS proxy.

**Rationale:** [TECHNICAL] MCP specification supports two transports: stdio (local) and Streamable HTTP (remote). SSE-based HTTP is the standard for remote MCP servers that Claude mobile, Kini, KimiClaw all support. `@modelcontextprotocol/sdk` provides `StreamableHTTPServerTransport` for this.

**Alternatives considered:** WebSocket transport — not standard in MCP SDK v1.x. Plain HTTP without SSE — doesn't support streaming responses from `memory_think`.

### D4: Single API key for cloud auth (nginx-level)

**Decision:** Auth is a single static API key checked at nginx level before the request reaches memory-hub. Header: `Authorization: Bearer <MEMORY_API_KEY>`. Nginx returns 401 for missing/wrong key. Key stored in nginx config (env-substituted from `.env`).

**Rationale:** Supports user-spec "один пользователь, один ключ". Checking at nginx keeps memory-hub auth-free (simpler, no auth logic in MCP handlers). Key rotation = update env var + nginx reload (no server restart needed).

**Alternatives considered:** Auth in memory-hub's HTTP middleware — adds complexity, doesn't change security posture for single-user case. OAuth — out of scope per user-spec.

### D5: gbrain AI gateway — configureGateway() at startup

**Decision:** Call gbrain's `configureGateway({ provider, apiKey, model, embeddingModel })` once in `config.ts` before serving requests. Provider is env-driven: `OPENAI_API_KEY` (default), `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY` — first non-empty wins.

**Rationale:** [TECHNICAL] gbrain's AI gateway (`src/core/ai/gateway.ts`) must be initialized via `configureGateway()` before any embed/generate call. Gateway supports OpenAI, Anthropic, Google, and OpenAI-compatible providers via Vercel AI SDK (`ai` package + `@ai-sdk/*`). Failing to call it before first use causes a runtime error. Synthesis (`memory_think`) and embedding (`memory_capture`) both require a configured provider.

**Alternatives considered:** Lazy init per-request — rejected, configureGateway() is designed as a one-time call and uses per-provider module-level caching.

### D6: PGLite data dir in ~/.universal-memory/brain/

**Decision:** Local mode stores PGLite data in `~/.universal-memory/brain/` (user home, no sudo). Configurable via `MEMORY_DATA_DIR` env var.

**Rationale:** Supports user-spec zero-admin constraint. Userspace write access guaranteed. Path follows XDG convention alternative (not `~/.config` to keep it obvious). Auto-created on first run.

**Alternatives considered:** `./.universal-memory/` relative to cwd — rejected, different cwd per tool invocation would create multiple separate brains.

### D7: memory_sign is idempotent by content hash

**Decision:** Before calling `MnemonicClient.signMemory()`, check if an attestation already exists for this content hash (stored in Postgres alongside the memory entry). If found, return existing `attestationId` without re-signing.

**Rationale:** Supports user-spec AC "Повторный вызов с тем же id → idempotent". Avoids duplicate Mnemonik calls (which have cost and latency in participate mode). Content hash (blake3, from gbrain's own hash) is the canonical dedup key.

**Alternatives considered:** Check by memory id only — simpler but breaks if same content stored twice under different ids.

### D8: Content size limits on memory_capture

**Decision:** `memory_capture` enforces a maximum content size of **10 MB** per call (after URL fetch / file read). Individual chunk size is capped at 2000 chars (existing). Images are limited to 5 MB base64. Oversized input → error `{ error: "content_too_large", max_bytes: 10485760 }`.

**Rationale:** [TECHNICAL] HTTP mode exposes memory_capture to the network. Unbounded content would allow OOM attacks and storage exhaustion. 10 MB is permissive for any legitimate knowledge capture (research papers, code files) while blocking abuse. Local stdio mode: same limit applies for consistency.

**Alternatives considered:** No limit (trust stdio mode, HTTP protected by auth) — rejected, single-user auth key compromise would enable storage exhaustion. Per-content-type limits (different for text vs PDF vs image) — more complex with marginal benefit.

### D9: Cloud mode requires external Postgres (not PGLite)

**Decision:** Cloud mode (`MEMORY_BACKEND=cloud`) requires `DATABASE_URL` pointing to an external Postgres 15+ with pgvector extension. PGLite is not used in cloud mode.

**Rationale:** [TECHNICAL] PGLite is single-writer WASM — not suitable for a long-running HTTP server under concurrent requests. Postgres with pgvector supports HNSW indexes, concurrent reads, and connection pooling. Docker Compose includes a `postgres` service with `pgvector/pgvector:pg16` image.

**Alternatives considered:** PGLite in cloud — rejected, PGLite's advisory locking model (`pglite-lock.ts` in gbrain) is designed for single-process local use only.

### D10: Bearer token constant-time comparison

**Decision:** Bearer token validation uses `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))` — constant-time string comparison. Nginx-level check uses `$http_authorization` with exact match (nginx's string comparison is not timing-safe but acceptable since the API key is already public to any network attacker who can observe the channel; the real protection is HTTPS).

**Rationale:** [TECHNICAL] Timing attacks on string comparison allow an attacker to measure response latency to guess the token byte-by-byte. Constant-time comparison closes this. Since nginx string comparison is not timing-safe, auth is also implemented in memory-hub's HTTP middleware as a defense-in-depth layer (D4 is nginx-primary but memory-hub also validates).

### D11: SSRF and path traversal mitigations in ingestion

**Decision:** URL fetcher blocks: `file://`, `ftp://` schemes; loopback (`127.0.0.1`, `::1`); private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`); max 3 redirects; 30s timeout. File ingestion: resolve symlinks via `Bun.file().realpath()`, then verify the resolved path is within an allowlist (`MEMORY_ALLOWED_DIRS` env var, defaults to `~/` i.e. user home only). Paths outside allowlist → error.

**Rationale:** [TECHNICAL] SSRF (A10) and path traversal (A03) are the two highest-risk attack vectors in the ingestion pipeline. SSRF via URL fetcher could allow reading internal cloud metadata (AWS IMDSv1, GCP metadata). Path traversal via file path argument could read `/etc/passwd` or cloud credentials. Both mitigations are standard and low-complexity.

### D12: Structured prompts for LLM synthesis (prompt injection defense)

**Decision:** `memory_think` passes captured content to LLM via clearly delimited sections: `<memory_context>` tags wrapping retrieved chunks. The synthesis instruction is a system-level prompt, not concatenated with user content. Response format is validated: must contain `answer`, `citations[]`, `gaps[]` JSON structure — malformed response → retry once, then error.

**Rationale:** [TECHNICAL] LLM prompt injection (A03/A04) is a real risk when user-captured content is used as context in synthesis. Structural separation of trusted instructions (system prompt) from untrusted context (memory chunks) reduces — though cannot eliminate — injection risk. Response structure validation catches obvious injection attempts that alter the output format.

### D13: Secret protection in logs

**Decision:** `config.ts` never logs raw values of: `MEMORY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `MNEMONIC_JWT`, `MNEMONIC_IDENTITY`. Startup log prints: `"provider: openai, key: sk-...xxxx (last 4 chars)"`. Error stack traces are scrubbed before logging via a `scrubSecrets(input)` helper that redacts: `Bearer <token>`, `sk-...` patterns, JSON containing `keypair` or `jwt` keys.

**Rationale:** [TECHNICAL] A03/A06 — secrets in logs is a common real-world incident cause. Single-user deployment means lower risk, but cloud VPS logs are often shipped to external services. Defense-in-depth at minimal implementation cost.

## Data Models

### Memory entry (Postgres / PGLite via gbrain's schema)

gbrain manages its own schema via migrations (`src/core/migrate.ts`). The primary page/chunk tables are gbrain-owned. We add one table:

```sql
-- Mnemonik attestation index (cloud mode only)
CREATE TABLE IF NOT EXISTS memory_attestations (
  page_id       TEXT NOT NULL,           -- gbrain page id
  content_hash  TEXT NOT NULL,           -- blake3 hex (gbrain contentHash)
  attestation_id TEXT NOT NULL,          -- Mnemonik attestationId
  signed_at     TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL,           -- 'signed' | 'anchored'
  PRIMARY KEY (page_id)
);
```

### MCP tool schemas

```typescript
// memory_capture
input:  { content: string, source?: string, tags?: string[] }
output: { id: string, chunks: number }

// memory_search
input:  { query: string, top_k?: number }  // top_k default 10
output: Array<{ id: string, content: string, score: number, source?: string, tags?: string[] }>

// memory_think
input:  { question: string }
output: { answer: string, citations: Array<{ id: string, excerpt: string }>, gaps: string[] }

// memory_sign
input:  { id: string, tags?: string[] }
output: { attestationId: string, signedAt: string, status: 'signed' | 'anchored' }

// memory_verify
input:  { attestationId: string }
output: { status: 'verified' | 'tampered' | 'not_found', signer?: string, arweaveTx?: string }

// memory_list
input:  { limit?: number }  // default 20
output: Array<{ id: string, content: string, source?: string, created_at: string }>

// memory_delete
input:  { id: string }
output: { status: 'deleted' }
```

### Config (env vars)

```bash
# Required (both modes)
MEMORY_BACKEND=local|cloud        # default: local
OPENAI_API_KEY=sk-...             # OR ANTHROPIC_API_KEY OR GOOGLE_API_KEY

# Local mode
MEMORY_DATA_DIR=~/.universal-memory/brain  # PGLite data directory

# Cloud mode
DATABASE_URL=postgres://...        # Postgres 15+ with pgvector
MEMORY_API_KEY=<secret>            # Bearer token (nginx validates)

# Optional (cloud + Mnemonik signing)
MNEMONIK_SIGNING=true
MNEMONIC_IDENTITY=<keypair-json>   # Ed25519 keypair from `npx @mnemonik-xyz/cli init`
MNEMONIC_JWT=<jwt>                 # from `npx @mnemonik-xyz/cli login`
MNEMONIC_MODE=local|participate    # default: local (SQLite, free)
```

## Dependencies

### New (memory-hub)

- `@electric-sql/pglite` + `@electric-sql/pglite/vector` + `@electric-sql/pglite/contrib/pg_trgm` — PGLite engine (via gbrain, already in gbrain's deps)
- `@modelcontextprotocol/sdk` ^1.x — MCP server + transports
- `@mnemonik-xyz/sdk` — Mnemonik client (optional, signing)
- `ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic` + `@ai-sdk/google` — via gbrain's gateway (already in gbrain's deps)
- `postgres` or `pg` — Postgres client for cloud mode (gbrain uses its own internally)
- `@mozilla/readability` + `jsdom` — URL → article markdown for fetcher
- `pdf-parse` or `pdfjs-dist` — PDF file ingestion
- Runtime: **Bun ≥1.3.10** (not Node.js — gbrain requires this minimum for PGLite WASM)

### Reused (from vendors/gbrain)

All gbrain library exports: `gbrain/pglite-engine`, `gbrain/engine`, `gbrain/search/hybrid`, `gbrain/ingestion`, `gbrain/ai/gateway`, `gbrain/embedding`, `gbrain/markdown`

### Infrastructure

- Docker + Docker Compose (memory-hub service + postgres service)
- nginx (Bearer auth + TLS termination)
- Let's Encrypt (certbot)
- Hetzner VPS (existing)

## Testing Strategy

**Feature size: L** — three-tier coverage required.

**Test timeout config:** PGLite cold start is 5–20s. Integration tests require extended timeout. Add `bunfig.toml` or vitest config: `test.timeout = 30000` (30s). First run slow; optional: `GBRAIN_PGLITE_SNAPSHOT` reduces to ~100ms.

### Unit tests (vitest, in `packages/memory-hub/`)

- `config.ts`: env parsing, configureGateway called with right provider, missing both LLM keys → startup error.
- `engine/factory.ts`: cloud mode with missing/invalid `DATABASE_URL` → throws with actionable message "Postgres connection failed: ...".
- `engine/factory.ts`: local mode creates PGLite engine, cloud mode creates Postgres engine, wrong backend → throws.
- `ingest/pipeline.ts`: plain text → direct; URL string → fetcher called; file path → file.read called; base64 prefix → image path; unknown type → error.
- `ingest/fetcher.ts`: valid URL → returns markdown string (mocked fetch); non-200 → throws with message.
- `mcp/auth.ts`: request with correct Bearer → passes; missing header → 401; wrong key → 401.
- `tools/capture.ts`: calls pipeline.dispatch + engine.upsertPage; returns `{ id, chunks }`.
- `tools/search.ts`: calls engine.search with hybrid=true; maps results to output schema; top_k default 10.
- `tools/think.ts`: calls engine.search then gateway.generateText; output has answer+citations+gaps.
- `tools/sign.ts`: local mode → throws "cloud only"; idempotent (same id twice → same attestationId); Mnemonik unavailable → actionable error.
- `tools/verify.ts`: delegates to MnemonicClient.verify; passes through discriminated union.
- `tools/delete.ts`: calls engine.deletePage; not-found → error.

### Integration tests (Bun test, against real PGLite in temp dir)

- `memory_capture` → `memory_search`: capture text → search with related query → content appears in results.
- `memory_capture` → `memory_think`: capture 3 entries → think question → answer cites captured ids.
- `memory_list` after capture: returns most recent first.
- `memory_delete` → `memory_search`: capture → delete → search returns empty.
- `memory_capture` URL: mock fetch → content indexed and searchable.

### E2E scenarios (requires running server + real LLM key)

- **E2E-1**: Claude Code MCP config → `memory_capture` → `memory_search` from KimiClaw MCP config → same result. (Validates shared cloud state.)
- **E2E-2**: `memory_capture` → `memory_think` → response contains `citations[].id` matching captured memory id.
- **E2E-3** (cloud + Mnemonik): `memory_capture` → `memory_sign` → `memory_verify` → `status: "verified"`.
- **E2E-4**: Coding Fabric agent system prompt includes universal-memory tools → agent captures output of a research task → verifiable in subsequent session.

### RUMBA benchmark (`packages/eval/`)

- Implement `MemoryService` adapter wrapping memory-hub MCP client.
- Run RUMBA ingestion pipeline: multi-session dialogue → `memory_capture` per turn.
- Run RUMBA evaluation: question → `memory_search` (RecallAccuracy@5) + `memory_think` (AnswerQuality LLM judge).
- Compare against mem0 baseline from `research/RUMBA/results/baselines.json`.

## Agent Verification Plan

### Tools required

- bash + curl (MCP HTTP smoke checks)
- Bun CLI (`bun test`, `bun run`)
- Docker Compose (cloud mode)
- Real LLM API key (OPENAI_API_KEY or ANTHROPIC_API_KEY) for integration tests

### Verification approach

- Per-task `Verify-smoke` commands (see tasks).
- Final Wave QA walks all user-spec ACs + tech-spec ACs.

## Risks

| Risk | Mitigation |
|---|---|
| gbrain API changes (it's under active development, 530 open issues) | Pin to a specific commit hash in `.gitmodules`, not a branch. Test suite catches breakage on update. |
| PGLite cold start: 5–20s on first `.connect()` call | Document in README. Wave 1 Task 1 verifies startup time. Optional: `GBRAIN_PGLITE_SNAPSHOT` env var reduces to ~100ms. MCP clients should expect slow first response. |
| PGLite WASM fails to load in Bun (version mismatch) | Wave 1 Task 1 spike: `bun -e "import('@electric-sql/pglite').then(({PGlite}) => new PGlite(':memory:').then(db => db.query('SELECT 1')))"` — fail fast before any tool work. |
| `runThink()` from `gbrain/think` not yet imported | Task 5 adds the import. If gbrain's think module is not exported as a library path, workaround: copy the function signature and call engine search + gateway directly. |
| gbrain `configureGateway()` called before module init (ordering issue) | Call in `config.ts` at import time (module-level), before server.listen(). Test: startup with no LLM key → clear error message, not a runtime crash mid-request. |
| Mnemonik JWT expiry (24h TTL) | `parseJwtPayload(jwt)` at startup; if expired → log warning but don't crash (signing tools return "JWT expired, re-run npx @mnemonik-xyz/cli login"). |
| `memory_think` latency (LLM call) | Expected 2-10s. MCP clients should handle this. Document in README. Post-MVP: streaming response via SSE. |
| pgvector extension not available on Postgres image | Use `pgvector/pgvector:pg16` Docker image (pre-installed). Verify in Wave 5 infra task. |
| LLM API key required for local mode (embedding needs it) | Document clearly: local mode requires `OPENAI_API_KEY` (or equivalent) for embedding. `memory_capture` without key → clear error: "LLM API key required for embedding. Set OPENAI_API_KEY." |
| gbrain's chunker/embedder API not stable as library | Wave 1 spike imports gbrain/ingestion and calls it — fail fast if API mismatch. Fallback: use gbrain's own `put_page` operation abstraction. |

## User-Spec Deviations

### DEV-1: LLM API key required for local mode [PENDING USER APPROVAL]

**User-spec says:** "Работает без прав администратора — никакого sudo, никаких системных сервисов, никаких глобальных установок."

**Tech-spec does differently:** Local mode needs an LLM API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) for embedding (memory_capture) and synthesis (memory_think). No admin rights — just an API key from an external service.

**Why:** gbrain uses vector embeddings for hybrid search. Without embeddings, search degrades to BM25 keyword-only and synthesis is unavailable.

**Recommended resolution — Option A (implemented in Task 1):**
- No LLM key set → `memory_capture` stores text but skips vector embedding (BM25-only mode)
- `memory_search` uses BM25 keyword search only (still useful, just less semantic)
- `memory_think` returns error: `"Synthesis requires LLM key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY."`
- Startup log: `"Universal Memory running in BM25-only mode (no LLM key configured)"`
- Zero-dependency basic search works out of the box; full semantic search requires API key

**Alternatives:** Option B (local embedding via Ollama) — adds binary dependency, more complex. Option C (fail fast on missing key) — breaks zero-dependency promise entirely.

### DEV-2: memory_sign requires Mnemonik JWT (external service) [TECHNICAL]

User-spec describes `memory_sign` as a tool. Implementation requires `MNEMONIC_JWT` from `https://mnemonik.xyz/install` — a one-time setup step not mentioned in user-spec flows. This is a pre-condition, not a behavioral change. Documenting as `[TECHNICAL]` — setup cost, not a deviation in functionality.

## Acceptance Criteria (technical complement)

- [ ] `cd /home/op/Projects/universal-memory && bun install` succeeds without sudo.
- [ ] `bun run packages/memory-hub/src/mcp/server.ts` starts in local mode, prints "Universal Memory Hub ready (local/PGLite)" to stderr.
- [ ] `bun test packages/memory-hub/` — all unit + integration tests pass.
- [ ] PGLite initializes in `~/.universal-memory/brain/` (or `MEMORY_DATA_DIR`) on first run.
- [ ] Cloud mode: `docker compose up memory-hub postgres -d` starts both services; nginx `memory.` subdomain returns 401 on missing auth.
- [ ] Cloud mode: correct Bearer → MCP tools/list returns 7 tools.
- [ ] DEV-1 resolution implemented (Option A or B or C, per user decision).

## Implementation Tasks

### Wave 1 — Foundation + config (parallel)

#### Task 1: config.ts + gbrain gateway init + LocalAdapter synthesis + gbrain patch

**Description:** Four tightly coupled gaps. (1) Patch `vendors/gbrain/package.json` to add export entry `"./think": "./src/core/think/index.ts"` — mirage fix (gbrain/think path doesn't exist in package.json yet). (2) Write `config.ts`: call `configureGateway()` at module-load; first non-empty of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` wins; missing all → startup warning (not crash) + BM25-only fallback mode (see DEV-1 resolution). (3) Wire `LocalAdapter.synthesize()`: import `runThink` from `gbrain/think`; call `runThink(engine, { question })`; map `ThinkResponse` to `{ answer, citations, gaps }`. (4) Confirm PGLite init sequence: `createEngine({ engine: 'pglite', dataDir })` from `gbrain/engine-factory` (not `createPgliteEngine()` — that function doesn't exist).
**Skill:** write-code
**Reviewers:** code-reviewer
**Verify-smoke:** `MEMORY_BACKEND=local bun -e "const {createEngine} = await import('./vendors/gbrain/src/core/engine-factory.ts'); const e = await createEngine({engine:'pglite',dataDir:'/tmp/test-brain'}); await e.connect({}); await e.initSchema(); console.log(e.kind)"` → prints `pglite`
**Files to modify:** `packages/memory-hub/src/config.ts` (new), `packages/memory-hub/src/storage/local.ts`, `vendors/gbrain/package.json` (add ./think export)
**Files to read:** `vendors/gbrain/src/core/pglite-engine.ts`, `vendors/gbrain/src/core/engine-factory.ts`, `vendors/gbrain/src/core/think/index.ts`, `vendors/gbrain/src/core/ai/gateway.ts`

#### Task 2: HTTP MCP transport + Bearer auth

**Description:** Existing `server.ts` is stdio-only. Add HTTP mode: when `MEMORY_BACKEND=cloud`, start `Bun.serve` HTTP server (port 3456). **First: verify actual MCP SDK HTTP transport class name** — check `@modelcontextprotocol/sdk` exports; if `StreamableHTTPServerTransport` absent, use gbrain's own `serve-http.ts` as pattern reference. Auth middleware: validate `Authorization: Bearer` using `crypto.timingSafeEqual()` (D10) — 401 JSON on failure. Stdio mode unchanged. Implement `scrubSecrets()` helper (D13) for log sanitization.
**Skill:** write-code
**Reviewers:** code-reviewer, security-auditor
**Verify-smoke:** `MEMORY_BACKEND=cloud MEMORY_API_KEY=test123 bun run packages/memory-hub/src/mcp/server.ts &` then `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" http://localhost:3456/mcp` → `401`; `curl -s -H "Authorization: Bearer test123" http://localhost:3456/mcp` → 200 with MCP JSON.
**Files to modify:** `packages/memory-hub/src/mcp/server.ts`, `packages/memory-hub/src/mcp/http.ts` (new), `packages/memory-hub/src/mcp/auth.ts` (new)
**Files to read:** `vendors/gbrain/src/mcp/serve-http.ts`, `node_modules/@modelcontextprotocol/sdk/dist/` (check actual exports)

### Wave 2 — Ingestion pipeline (after Wave 1)

#### Task 3: Multi-content-type ingestion pipeline

**Description:** `IngestPipeline.dispatch(input)` detects content type and routes: plain string → direct text, `http(s)://` URL → fetch + Readability → markdown, local file path → read (PDF via pdf-parse, code/md as-is), base64 `data:image/` → image embedding. Calls gbrain engine's page upsert with chunked content. Returns `{ id, chunks }`.
**Skill:** write-code
**Reviewers:** code-reviewer, test-reviewer
**Verify-smoke:** Integration test: `pipeline.dispatch("https://example.com")` → mocked fetch → engine stores content → `engine.search("example")` returns hit.
**Files to modify:** `packages/memory-hub/src/ingest/pipeline.ts`, `packages/memory-hub/src/ingest/fetcher.ts`, `packages/memory-hub/src/ingest/file.ts`
**Files to read:** `vendors/gbrain/src/core/ingestion/index.ts`, `vendors/gbrain/src/core/import-file.ts`

### Wave 3 — Complete MCP tool handlers (after Waves 1+2, parallel)

#### Task 4: Wire capture, search, list, delete in server.ts

**Description:** The tool stubs exist in `server.ts` but are incomplete. Wire up: `memory_capture` → `ingest.add()` (already exists); `memory_search` → `storage.search()` with `topK` param; `memory_list` → `engine.listPages({ limit })`; `memory_delete` → `engine.deletePage(id)` with not-found error. All return typed shapes per Data Models. Note: `memory_clear` in current scaffold becomes `memory_delete` (rename to match user-spec).
**Skill:** write-code
**Reviewers:** code-reviewer, test-reviewer
**Verify-smoke:** `bun test packages/memory-hub/ -t "capture|search|list|delete"` — all pass with PGLite in temp dir.
**Files to modify:** `packages/memory-hub/src/mcp/server.ts`
**Files to read:** `packages/memory-hub/src/storage/index.ts`, `packages/memory-hub/src/ingest/index.ts`, `work/universal-memory-system/code-research.md`

#### Task 5: Wire memory_think + CloudAdapter

**Description:** (1) Wire `memory_think` handler: call `storage.synthesize({ question })` → which calls `runThink(engine, { question })` from `gbrain/think`. Map `ThinkResponse` citations (ParsedCitation[]) to output `{ id, excerpt }` shape. Handle "no LLM key" gracefully. (2) Create `CloudAdapter` (`storage/cloud.ts`) wrapping gbrain's `PostgresEngine` via `createEngine({ engine: 'postgres', ... })` with `DATABASE_URL`. Same `StorageAdapter` interface as `LocalAdapter`.
**Skill:** write-code
**Reviewers:** code-reviewer, test-reviewer
**Verify-smoke:** Integration (real LLM key): capture 3 texts → `memory_think("question")` → response has `answer` string + `citations` array with ids matching captured memories.
**Files to modify:** `packages/memory-hub/src/mcp/server.ts`, `packages/memory-hub/src/storage/cloud.ts` (new)
**Files to read:** `vendors/gbrain/src/core/think/index.ts`, `vendors/gbrain/src/core/engine-factory.ts`, `work/universal-memory-system/code-research.md`

### Wave 4 — Mnemonik integration (parallel with Wave 3)

#### Task 6: Mnemonik adapter + Sign/Verify tools

**Description:** Rewrite `adapters/mnemonik.ts` to use the real `@mnemonik-xyz/sdk` (`MnemonicClient`, `LocalSigner`, `Keypair`). Implement `memory_sign` (local mode → "cloud only" error; idempotent via content hash check in `memory_attestations` table; calls `MnemonicClient.signMemory()`) and `memory_verify` (calls `MnemonicClient.verify()`). Create `memory_attestations` table migration.
**Skill:** write-code
**Reviewers:** code-reviewer, security-auditor
**Verify-smoke:** `MNEMONIK_SIGNING=true MNEMONIC_JWT=... MNEMONIC_IDENTITY=... bun test packages/memory-hub/src/tools/sign.test.ts` — idempotency test passes (mock MnemonicClient).
**Files to modify:** `packages/memory-hub/src/adapters/mnemonik.ts`, `packages/memory-hub/src/tools/sign.ts`, `packages/memory-hub/src/tools/verify.ts`
**Files to read:** `vendors/mnemonik/packages/sdk/src/client.ts`, `vendors/mnemonik/packages/sdk/src/types.ts`

### Wave 5 — Infrastructure (after Wave 3)

#### Task 7: Docker Compose + nginx + HTTPS config

**Description:** Add `memory-hub` and `postgres` (pgvector/pgvector:pg16) services to Docker Compose. `Dockerfile` for memory-hub: Bun base image, install deps, copy source, `CMD ["bun", "run", "src/mcp/server.ts"]`. nginx config: `memory.` subdomain → proxy to memory-hub:3456 with `auth_request` or `if` Bearer check, HTTPS via Let's Encrypt (certbot). `.env.example` updated with all new vars.
**Skill:** deploy-pipeline
**Reviewers:** code-reviewer, infrastructure-reviewer
**Verify-smoke:** `docker compose build memory-hub && docker compose up memory-hub postgres -d && curl -H "Authorization: Bearer wrong" https://memory.yourdomain.com/mcp` → 401.
**Files to modify:** `docker-compose.yml`, `docker/memory-hub/Dockerfile`, `nginx/memory.conf`, `.env.example`
**Files to read:** `packages/memory-hub/package.json`, `packages/memory-hub/src/mcp/server.ts`

### Wave 6 — Tests + RUMBA eval (after Wave 5)

#### Task 8: Unit + integration test suite

**Description:** Full test suite for all tool handlers and pipeline (per Testing Strategy). Mock gbrain engine in unit tests (interface-based mock). Real PGLite in integration tests (temp dir, cleaned after each test). Target: ≥80% line coverage on `packages/memory-hub/src/`.
**Skill:** write-code
**Reviewers:** code-reviewer, test-reviewer
**Verify-smoke:** `bun test packages/memory-hub/ --coverage` — all pass, ≥80% coverage reported.
**Files to modify:** `packages/memory-hub/src/**/*.test.ts`
**Files to read:** All `packages/memory-hub/src/`

#### Task 9: RUMBA eval harness + client config docs for all 4 surfaces

**Description:** (1) Implement `packages/eval/` RUMBA adapter: `MemoryService` wrapping memory-hub MCP client (`add_one` → `memory_capture`, `get_relevant_memories` → `memory_search`). Run baseline eval and universal-memory eval; write results to `research/RUMBA/results/`. Pass criteria: RecallAccuracy@5 ≥ mem0 baseline, AnswerQuality ≥ 0.7 — hard-coded as assertions in harness. (2) Write client config snippets in README for ALL 4 surfaces: Claude Code (`mcpServers` in `.claude/settings.json`), KimiClaw (OpenClaw MCP config), Kini (MCP config), **Coding Fabric** (`CLAUDE.md` system prompt + MCP config). Include E2E-4 verification step: Fabric agent invokes `memory_capture` + `memory_think` during a task.
**Skill:** write-code
**Reviewers:** test-reviewer
**Verify-smoke:** `cd packages/eval && python run.py --service universal-memory --backend local 2>&1 | grep -E "RecallAccuracy|AnswerQuality|PASS|FAIL"` — outputs metric lines without crash.
**Files to modify:** `packages/eval/adapters/universal_memory.py`, `packages/eval/run.py`, `README.md`, `adapters/fabric/CLAUDE.md` (new — Fabric agent system prompt with MCP config)
**Files to read:** `research/RUMBA/services/interface.py`, `research/RUMBA/evaluation/`, `adapters/fabric/patterns/`

### Audit Wave (parallel, after Wave 6)

#### Task 10: Code Audit

**Description:** Holistic code quality review of all feature code in `packages/memory-hub/src/` and `packages/eval/`. Write `work/universal-memory-system/audit-code.md`.
**Skill:** code-reviewing
**Reviewers:** none

#### Task 11: Security Audit

**Description:** OWASP audit: Bearer token handling, input validation in tool handlers (content size limits, path traversal in file ingestion, SSRF in URL fetcher), Mnemonik JWT handling, LLM prompt injection via captured content. Write `work/universal-memory-system/audit-security.md`.
**Skill:** security-auditor
**Reviewers:** none

#### Task 12: Test Audit

**Description:** Verify coverage targets, integration test completeness, E2E scenario coverage, RUMBA harness correctness. Write `work/universal-memory-system/audit-tests.md`.
**Skill:** test-master
**Reviewers:** none

### Final Wave

#### Task 13: Pre-deploy QA

**Description:** Block if `status: draft`. Run full test suite. Walk all user-spec and tech-spec ACs. Verify local mode (no sudo) and cloud mode (Docker) both work. Verify all 5 client surfaces can connect. Produce QA report.
**Skill:** pre-deploy-qa
**Reviewers:** none
**Verify-smoke:** `bun test packages/memory-hub/ && docker compose up memory-hub postgres -d && curl -H "Authorization: Bearer $MEMORY_API_KEY" https://memory.yourdomain.com/mcp` → tools/list returns 7 tools.

#### Task 14: Deploy to VPS + client config distribution

**Description:** Deploy memory-hub to Hetzner VPS via Docker Compose. Verify HTTPS endpoint live. Write and distribute client config snippets (Claude Code, KimiClaw, Kini, Coding Fabric). Commit final README with quickstart.
**Skill:** deploy-pipeline
**Reviewers:** none
**Verify-smoke:** From a fresh Claude Code install: add MCP config → list tools → `memory_capture("hello world")` → `memory_search("hello")` → returns hit.
