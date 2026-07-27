# Universal Memory System — Deep Code Research

## Project Structure

**Root:** `/home/op/Projects/universal-memory/`
- **MCP Server (main deliverable):** `packages/memory-hub/src/mcp/server.ts`
- **Storage abstraction:** `packages/memory-hub/src/storage/`
- **Ingestion pipeline:** `packages/memory-hub/src/ingest/`
- **Adapters:** `packages/memory-hub/src/adapters/`
- **gbrain vendored library:** `vendors/gbrain/`
- **Mnemonik SDK vendored:** `vendors/mnemonik/packages/sdk/`

---

## 1. What's Already Implemented vs Stub

### ✅ IMPLEMENTED

**MCP Server scaffold** (`packages/memory-hub/src/mcp/server.ts`):
- Full MCP server with StdioServerTransport
- 7 MCP tools defined (memory_capture, memory_search, memory_think, memory_verify, memory_sign, memory_sync, memory_clear)
- Tool handlers dispatching to storage and adapters
- Optional Mnemonik signing integration with env-var gating

**Storage abstraction** (`packages/memory-hub/src/storage/index.ts`):
- `StorageAdapter` interface with: `search()`, `synthesize()`, `add()`, `clear()`, `sync()`
- `StorageFactory` pattern supporting "local" | "cloud" | "hybrid" backends
- Dynamic import strategy to avoid loading unnecessary WASM

**LocalAdapter** (`packages/memory-hub/src/storage/local.ts`):
- Delegates to gbrain's `PGLiteEngine` via lazy-loaded import
- Implements all StorageAdapter methods
- Git-backed storage: memories stored as markdown files in `~/.universal-memory/brain/`
- PGLite data directory: `{gitDir}/.pglite`

**Ingestion pipeline** (`packages/memory-hub/src/ingest/index.ts`):
- UUID-based content ID generation
- Simple sliding-window text chunker (2000-char window, 200-char overlap)
- Per-chunk upsert to storage adapter
- Returns ingestion result: `{id, chunks}`

**MnemonikAdapter** (`packages/memory-hub/src/adapters/mnemonik.ts`):
- Full integration with `@mnemonik-xyz/sdk` MnemonicClient
- `sign()` → calls `client.signMemory()`
- `verify()` → calls `client.verify()` (checks Ed25519 signature + optional Arweave/Solana anchors)
- `recall()` → calls `client.recall()` for Mnemonik-native semantic search
- Mode support: "local" (SQLite, free) | "participate" (Arweave + Solana, paid)
- Auth: JWT + MNEMONIC_IDENTITY (keypair JSON)

### ❌ STUBS / NOT YET IMPLEMENTED

1. **CloudAdapter** (`packages/memory-hub/src/storage/cloud.ts` — NOT CREATED)
   - Referenced by StorageFactory but file doesn't exist
   - Should wrap gbrain's PostgresEngine for remote Postgres
   - Would need: databaseUrl config, PostgresEngine init

2. **HybridAdapter** (`packages/memory-hub/src/storage/hybrid.ts` — NOT CREATED)
   - Local PGLite + cloud Postgres sync
   - Bidirectional push/pull for cross-device access

3. **Mnemonik recall integration in search**
   - Server.ts calls `storage.search()` but doesn't supplement with `mnemonik.recall()`
   - MCP tool handler doesn't merge Mnemonik hits into hybrid-search results

4. **storage.sync() implementation**
   - LocalAdapter returns `{pushed: 0}` (no-op)
   - CloudAdapter and HybridAdapter not defined yet

---

## 2. Exact gbrain Engine API — Method Signatures

### BrainEngine Interface (PostgresEngine & PGLiteEngine implement this)

**File:** `vendors/gbrain/src/core/engine.ts` (line 659+)

```typescript
export interface BrainEngine {
  readonly kind: 'postgres' | 'pglite';
  
  // SEARCH METHODS
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchTitles(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
  
  // SYNTHESIS / THINK
  // (Note: think() is NOT a BrainEngine method — it's a standalone function in gbrain/think)
  
  // CHUNK OPERATIONS
  upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string } & BatchOpts): Promise<void>;
  getChunks(slug: string, opts?: { sourceId?: string }): Promise<Chunk[]>;
  deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void>;
  
  // PAGE CRUD
  putPage(slug: string, page: PageInput, opts?: { sourceId?: string }): Promise<Page>;
  getPage(slug: string, opts?: GetPageOpts): Promise<Page | null>;
  deletePage(slug: string, opts?: { sourceId?: string }): Promise<void>;
  
  // LIFECYCLE
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;
}
```

### Key Type Signatures

**SearchResult:**
```typescript
interface SearchResult {
  id: string;              // chunk_id
  page_id: number;
  page_slug: string;
  chunk_index: number;
  chunk_text: string;
  score: number;           // RRF fused rank (0–1+)
  source?: string;
  source_id: string;
  embedding?: Float32Array;
  created_at?: Date;
}

interface SearchOpts {
  query?: string;          // optional for vector-only search
  userId?: string;         // source_id filter (scopes to one source)
  sourceIds?: string[];    // array scope for federated read
  limit?: number;          // default 20, max 100
  topK?: number;           // alias for limit
  // ... 20+ other options (boosts, recency, autocut, etc.)
}
```

**Chunk Operations:**
```typescript
interface ChunkInput {
  chunk_text: string;
  chunk_index: number;
  embedding?: Float32Array;  // optional; if null, engine skips embedding
  compiled_truth?: boolean;  // promoted chunk flag
  metadata?: Record<string, unknown>;
}

interface Chunk extends ChunkInput {
  id: number;
  page_id: number;
  page_slug: string;
  source_id: string;
  embedding?: Float32Array;   // fetched separately via getEmbeddingsByChunkIds()
  created_at: Date;
  updated_at: Date;
}
```

**Page Operations:**
```typescript
interface PageInput {
  title: string;
  body: string;
  doc_comment?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;       // auto-computed if omitted
  metadata?: Record<string, unknown>;
}

interface Page extends PageInput {
  id: number;
  slug: string;
  source_id: string;
  source_path?: string;        // file path for sync operations
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date | null;    // soft-delete
}
```

---

## 3. PGLite Engine Initialization

**File:** `vendors/gbrain/src/core/pglite-engine.ts` (line 267+)

### Constructor & Initialization Flow

```typescript
class PGLiteEngine implements BrainEngine {
  private db: PGlite;
  readonly kind = 'pglite';

  // NO PUBLIC CONSTRUCTOR — use engine-factory.createEngine()
  
  async connect(config: EngineConfig): Promise<void> {
    // EngineConfig shape:
    interface EngineConfig {
      engine?: 'pglite' | 'postgres';
      dataDir?: string;        // e.g., ~/.universal-memory/brain/.pglite
      ftsLanguage?: string;    // 'english' | 'french' | ... (default via getFtsLanguage())
    }
    
    // WASM initialization:
    // 1. PGlite.create(options) loads @electric-sql/pglite WASM runtime
    // 2. Attaches vector extension (@electric-sql/pglite/vector)
    // 3. Attaches pg_trgm contrib (trigram fuzzy matching)
    // 4. Runs migrations (runMigrations) to init schema
  }
}
```

### How to Create PGLiteEngine (via factory)

**File:** `vendors/gbrain/src/core/engine-factory.ts`

```typescript
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';
  
  if (engineType === 'pglite') {
    const { PGLiteEngine } = await import('./pglite-engine.ts');
    return new PGLiteEngine();
  }
  // ...
}
```

**CRITICAL:** PGLiteEngine is instantiated WITHOUT arguments; config is passed to `.connect()`:

```typescript
const engine = new PGLiteEngine();
await engine.connect({
  engine: 'pglite',
  dataDir: process.env.HOME + '/.universal-memory/brain/.pglite',
});
await engine.initSchema();
```

### Data Directory Configuration

- **PGLite data path:** Passed as part of EngineConfig or embedded in WASM runtime
- **LocalAdapter sets:** `dataDir: gitDir + '/.pglite'`
- **File structure:** PGLite creates `pglite.data` (WAasm binary blob) + SQLite WAL files inside dataDir
- **Zero config:** No separate postgres.conf needed; PGLite is fully embedded

---

## 4. AI Gateway for Synthesis

**File:** `vendors/gbrain/src/core/ai/gateway.ts` (lines 1–50)

### Synthesis Flow (think module)

**File:** `vendors/gbrain/src/core/think/index.ts`

```typescript
export interface RunThinkOpts {
  question: string;
  anchor?: string;           // optional entity slug for graph-based reasoning
  rounds?: number;           // default 1
  model?: string;            // override model (falls through 6-tier resolution chain)
  embedQuestion?: (q: string) => Promise<Float32Array | null>;
  client?: ThinkLLMClient;   // inject LLM client (for tests)
}

// DOES NOT exist on BrainEngine; it's a standalone function:
export async function runThink(
  engine: BrainEngine,
  opts: RunThinkOpts,
): Promise<ThinkResponse> {
  // 1. GATHER: runGather(engine, question) → SearchResult[] + TakeHit[]
  // 2. SYNTHESIZE: call LLM with context + citation markers
  // 3. PARSE: resolveCitations() maps citation IDs to chunk/take sources
  // 4. (optional) COMMIT: putPage(synthesisSummary) + upsertFacts()
}

export interface ThinkResponse {
  answer: string;                    // synthesized prose
  citations: ParsedCitation[];       // {citationId, source, slug, page_id, chunk_index}
  gaps: string[];                    // identified knowledge gaps
  sources: SearchResult[];           // hydrated pages/chunks
  model: string;                     // resolved model name
  inputTokens: number;
  outputTokens: number;
}
```

### LLM Provider Configuration

**Gateway config (from ai/gateway.ts):**

```typescript
export async function configureGateway(config: AIGatewayConfig): Promise<void> {
  // Supports:
  // - OpenAI (via @ai-sdk/openai, default 'gpt-4-turbo' / 'gpt-4o')
  // - Google Generative AI (via @ai-sdk/google, 'gemini-1.5-pro')
  // - Anthropic (via @ai-sdk/anthropic, 'claude-opus' / 'claude-sonnet')
  // - Custom OpenAI-compatible (via @ai-sdk/openai-compatible, e.g. local Ollama)
}

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;  // OpenAI 3-small; 3-large = 3072
```

**For MCP server (memory-hub):**
- No LLM provider configured by default in LocalAdapter
- `storage.synthesize()` would need to call gbrain's `runThink()` with an injected LLM client
- **NOT YET WIRED:** The MCP tool `memory_think` calls `storage.synthesize()` but LocalAdapter doesn't implement synthesis

---

## 5. Ingestion Pipeline Expectations

**File:** `packages/memory-hub/src/ingest/index.ts`

### Input Contract

```typescript
interface IngestOpts {
  content: string;          // raw text, URL body, transcript, etc.
  source?: string;          // 'url:https://...', 'file:/path/to/doc.pdf', 'transcript:meeting-123'
  userId?: string;          // scopes memory to a user (maps to source_id in gbrain)
}
```

### Processing Flow

1. **Chunking:** Splits content into 2000-char windows with 200-char overlap
2. **Per-chunk upsert:** Each chunk calls `storage.add({ id, content, source, userId })`
3. **Storage layer then:**
   - Generates embedding vector (if LLM available)
   - Upserts into content_chunks table
   - Updates full-text search index (tsvector)

### What's Missing

- **No semantic enrichment:** No entity extraction, topic classification, or relation detection
- **No deduplication:** Duplicate content ingests create duplicate chunks
- **gbrain's ingestion module:** Exists (`vendors/gbrain/src/core/ingestion/index.ts`) but not used
  - Exports: `IngestionSource`, `IngestionEvent`, `computeContentHash`, `validateIngestionEvent`
  - Designed for skillpack publishers (external data sources)
  - Would require wrapping in a formal `IngestionSource` plugin interface

---

## 6. MnemonicClient.signMemory() Exact Signature

**File:** `vendors/mnemonik/packages/sdk/src/client.ts` (lines 157–189)

```typescript
async signMemory(
  content: string,
  opts: SignMemoryOptions = {}
): Promise<SignMemoryResult>
```

### Types

```typescript
interface SignMemoryOptions {
  tags?: string[];                   // arbitrary metadata tags
  mode?: 'local' | 'participate';   // optional, falls back to client config
}

interface SignMemoryResult {
  attestationId: string;             // unique ID for verification
  signedAt: string;                  // ISO timestamp
  status: 'signed' | 'pending' | 'anchored';  // local vs chain status
  arweave_tx?: string;               // Arweave TX ID (participate mode)
  solana_tx?: string;                // Solana anchor TX ID (participate mode)
  content_hash?: string;             // hash of signed content
  signer?: string;                   // Ed25519 pubkey
}
```

### Flow

1. **POST /mcp tools/call mnemonic_sign_memory** → returns `correlation_id`
2. **GET /api/pending/{correlation_id}** → canonical CBOR bytes
3. **coseSignPayload(cbor, keypair)** → COSE_Sign1 envelope (client-side)
4. **POST /api/sign-callback** → `{attestation_id, ...}` (no JWT — capability auth via signature)

**CRITICAL:** No client-side signing; server provides CBOR payload, client wraps in COSE_Sign1, server verifies.

---

## 7. Files to Create vs Modify

### ✅ CREATE (new files needed)

1. **`packages/memory-hub/src/storage/cloud.ts`**
   - Implement `CloudAdapter` for Postgres backend
   - Constructor: `new CloudAdapter({ databaseUrl })`
   - Methods: search, synthesize, add, clear, sync (push-only or bidirectional)
   - Use gbrain's `PostgresEngine` (lazy-import)

2. **`packages/memory-hub/src/storage/hybrid.ts`**
   - Implement `HybridAdapter` (local PGLite + cloud Postgres)
   - Constructor: `new HybridAdapter({ gitDir, databaseUrl })`
   - Dual engines: local + cloud
   - Methods: search (prioritize local, fallback cloud), sync (bidirectional), clear (both)

3. **`packages/memory-hub/src/storage/postgres-engine.ts`** (optional if gbrain's PostgresEngine not re-exported)
   - Or just import from gbrain directly

### ✏️ MODIFY (existing files)

1. **`packages/memory-hub/src/storage/local.ts`**
   - Add proper type annotations for engine
   - Implement `storage.synthesize()` — currently throws or stubs
   - Wire LLM embedding (embed question for vector search in synthesize)

2. **`packages/memory-hub/src/mcp/server.ts`**
   - Implement `memory_think` tool handler fully
     - Call `storage.synthesize()` (which calls gbrain's `runThink()` internally)
     - Return structured answer + citations
   - Merge `mnemonik.recall()` results into `memory_search` hybrid results
   - Implement `memory_sync` direction handling (currently stubs direction param)

3. **`packages/memory-hub/src/ingest/index.ts`**
   - Replace simple chunker with gbrain's chunker (for consistency)
   - Add optional semantic enrichment (entity extraction, etc.)
   - Compute content_hash before insert (dedup signal)

4. **`packages/memory-hub/package.json`**
   - Already has correct deps; no changes needed
   - Verify `gbrain` workspace dependency resolves

---

## 8. Gotchas and Constraints

### Bun Version Requirement

**File:** `vendors/gbrain/package.json` (line 143)

```json
"engines": {
  "bun": ">=1.3.10"
}
```

- **Minimum:** Bun 1.3.10 (for PGLite WASM support)
- **Recommended:** Latest stable (Bun 1.5+)
- **Node.js:** gbrain does NOT officially support Node.js (PGLite WASM is Bun-specific on some platforms)
- **Memory-hub:** Currently runs on Bun (see `scripts: { dev: "bun --watch src/mcp/server.ts" }`)

### WASM Requirements

1. **PGLite loads WASM at runtime:**
   - First `.connect()` call initializes Bun's WASM runtime
   - ~5–20s cold start on loaded machines (see bunfig.toml test timeout = 60s)
   - Snapshot optimization: `GBRAIN_PGLITE_SNAPSHOT` env var for fast restore (~100ms vs 5s)

2. **Vector extension (pgvector):**
   - Auto-installed by @electric-sql/pglite/vector
   - Backed by HNSW index for fast ANN search
   - Embedding dimensions: default 1536 (OpenAI), configurable per model

3. **pg_trgm (trigram):**
   - Auto-installed by @electric-sql/pglite/contrib/pg_trgm
   - Used for fuzzy title matching and typo-tolerant search

### MCP Transport

**File:** `packages/memory-hub/src/mcp/server.ts` (line 209)

```typescript
const transport = new StdioServerTransport();
await server.connect(transport);
```

- **Stdio only:** Works with Claude Code, Cursor, VS Code, ChatGPT, etc.
- **No HTTP:** No built-in HTTP endpoint (would require wrapper server)
- **One-shot:** Server runs for the lifetime of the client session, then exits

### Mnemonik Auth

- **Required env vars** (if signing enabled):
  - `MNEMONIC_IDENTITY`: JSON-serialized Ed25519 keypair
  - `MNEMONIC_JWT`: Signed JWT from OAuth 2.1 + PKCE flow
  - `MNEMONIC_MODE`: 'local' or 'participate'
  - `MNEMONIC_BASE_URL`: (optional, defaults to `https://mcp.mnemonik.xyz`)

- **Expired JWT:** MnemonikAdapter validates immediately in constructor
  - `parseJwtPayload(jwt)` throws `AuthError` if expired
  - No automatic refresh; must obtain fresh token before restart

- **Cost model:**
  - Local mode: Free (SQLite only)
  - Participate mode: Paid (Arweave + Solana anchoring, immutable)

### Search Options — RRF Fusion

**File:** `vendors/gbrain/src/core/search/hybrid.ts` (lines 1–60)

```typescript
// RRF_K = 60 (Reciprocal Rank Fusion denominator)
// RRF score = sum(1 / (60 + rank_in_list))
// COMPILED_TRUTH_BOOST = 2.0x (post-fusion multiplier for compiled_truth chunks)
// Cosine re-score blends: 0.7*rrf + 0.3*cosine
```

- Hybrid search combines keyword (BM25) + vector (cosine) via RRF
- Deduplicates by page + chunk_index
- Optional reranker (cross-encoder) for final ranking
- Autocut: removes low-confidence results based on intent classification
- Query cache: semantic embeddings cached per query (avoid re-embedding)

---

## 9. Implementation Roadmap (Priority Order)

### Phase 1: Complete LocalAdapter (BLOCKING)
1. Implement `storage.synthesize()`:
   - Import `runThink` from gbrain/think
   - Create LLM client (stub or real Anthropic client)
   - Call runThink(engine, { question, ...opts })
   - Return answer string (with citations)
2. Wire embedding in LocalAdapter.add() if not already done by gbrain

### Phase 2: Wire MCP Tool Handlers
1. `memory_think`: Call `storage.synthesize()` correctly
2. `memory_search`: Optionally merge `mnemonik.recall()` if available
3. `memory_sync`: Stub out or delegate to storage adapter

### Phase 3: Create CloudAdapter (if multi-device is planned)
1. Use gbrain's `PostgresEngine`
2. Handle DATABASE_URL config
3. Implement bidirectional sync via transaction log or timestamp watermark

### Phase 4: Deduplication & Enrichment (nice-to-have)
1. Replace IngestPipeline.chunk() with gbrain's chunker
2. Add entity extraction via LLM
3. Compute content_hash for dedup pre-check

---

## 10. Dependency Inventory

### gbrain exports used by memory-hub

- `gbrain` → PGLiteEngine, PostgresEngine (indirect via engine-factory)
- `gbrain/engine-factory` → createEngine()
- `gbrain/pglite-engine` → createPgliteEngine() **[used directly in local.ts]**
- `gbrain/think` → runThink() **[NOT YET IMPORTED]**
- `gbrain/search/hybrid` → hybridSearch() **[NOT YET IMPORTED]**

### @mnemonik-xyz/sdk exports used

- `MnemonicClient` → constructor(config: MnemonicClientConfig)
- `LocalSigner` → constructor(keypair: Keypair)
- `Keypair` → .fromJSON(), .toJSON()
- `parseJwtPayload(jwt: string)` → validation helper
- Types: `SignMemoryResult`, `VerifyResult`, `RecallHit`

### @modelcontextprotocol/sdk

- `Server` → MCP server constructor
- `StdioServerTransport` → Stdio-only transport
- `CallToolRequestSchema`, `ListToolsRequestSchema` → MCP request handlers

---

## Summary Table

| Component | Status | Key File | Notes |
|-----------|--------|----------|-------|
| MCP Server | ✅ Implemented | server.ts | Tools defined, handlers need completion |
| LocalAdapter | 🟡 Partial | local.ts | search/add done, synthesize stubbed |
| CloudAdapter | ❌ Missing | N/A | Needs Postgres integration |
| HybridAdapter | ❌ Missing | N/A | Needs dual-engine sync |
| IngestPipeline | ✅ Implemented | ingest/index.ts | Works but could use gbrain's chunker |
| MnemonikAdapter | ✅ Implemented | adapters/mnemonik.ts | Full integration ready |
| gbrain integration | 🟡 Partial | Various | Engine basics done, synthesis missing |
| LLM gateway | ❌ Wired | N/A | configureGateway() not called |

