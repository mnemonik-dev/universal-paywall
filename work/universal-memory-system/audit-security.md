# Security Audit — Universal Memory System
**Date:** 2026-07-27
**Auditor:** security-auditor (Task 11)
**Scope:** All source in `packages/memory-hub/src/`, Docker/nginx infra, eval adapter
**Standard:** OWASP Top 10 (2021)

---

## Executive Summary

The implementation demonstrates **solid security engineering discipline** across all five focus decisions (D8, D10, D11, D12, D13). The critical paths — Bearer token auth, SSRF blocking, path traversal, and secret log scrubbing — are all implemented correctly with meaningful defense-in-depth. No critical or high-severity vulnerabilities were found in the targeted decisions.

Three medium and four low findings are identified, none of which are exploitable in the current single-user deployment model but become relevant as the system scales.

**Verdict by decision:**

| Decision | Status |
|----------|--------|
| D8 — Content size limits | PASS |
| D10 — Bearer constant-time comparison | PASS |
| D11 — SSRF and path traversal mitigations | PASS (with noted limitations) |
| D12 — Structured prompts / prompt injection defense | PARTIAL — implementation present, structural isolation gap noted |
| D13 — Secret protection in logs | PASS |

---

## Findings

### MEDIUM-1: Input Validation Missing on Numeric Tool Arguments — A03 (Injection)

**OWASP:** A03:2021 Injection / A04:2021 Insecure Design

**Files:** `packages/memory-hub/src/mcp/server.ts` lines 177, 214

**Description:**
The tool handlers cast numeric arguments from the MCP `args` object without bounds checking:

```typescript
topK: (args.top_k as number) ?? 10,          // line 177
const limit = (args.limit as number) ?? 20;   // line 214
```

An MCP client can send `top_k: 100000` or `limit: 2147483647`. These values flow directly into `engine.search({ limit: topK })` and `engine.listPages({ limit })` which translate to SQL `LIMIT` clauses. Extremely large values cause:
- DoS via massive result set allocation (OOM/latency)
- Postgres query plans degradation

Similarly, `args.direction` for `memory_sync` is cast unchecked; if any invalid direction string is passed through to the engine without validation it could produce confusing error paths.

**Severity:** Medium (DoS potential, not data-breach)

**Recommendation:**
```typescript
// server.ts
const topK = Math.min(Math.max(1, (args.top_k as number) ?? 10), 100);
const limit = Math.min(Math.max(1, (args.limit as number) ?? 20), 500);
```
Add a `clamp(value, min, max)` helper. For `direction`, validate against the enum values in the tool schema (`["push", "pull", "bidirectional"]`).

---

### MEDIUM-2: No Rate Limiting on Stdio / Local MCP Mode — A04 (Insecure Design)

**OWASP:** A04:2021 Insecure Design / A05:2021 Security Misconfiguration

**Files:** `packages/memory-hub/src/mcp/server.ts`, `nginx/memory.conf`

**Description:**
Rate limiting (30 req/min burst 10) is implemented at the nginx layer (cloud/HTTP mode). In **local stdio mode**, there is no rate limiting at all. A MCP client (e.g. a compromised or misbehaving agent) could issue thousands of `memory_capture` calls in rapid succession, exhausting disk (PGLite database growth), CPU (embedding calls), and LLM API quota with no throttle.

For the current single-user local deployment this is lower risk. However the `user_id` parameter in every tool allows multi-user routing, suggesting future use where this gap matters more.

**Severity:** Medium (resource exhaustion risk when LLM key is configured)

**Recommendation:**
Add per-user/per-session rate limiting in the MCP `CallToolRequest` handler using a simple in-memory token bucket. At minimum document this gap in README for production deployments.

---

### MEDIUM-3: `scrubSecrets()` Does Not Cover Anthropic/Google Key Patterns — A09 (Logging Failures)

**OWASP:** A09:2021 Security Logging and Monitoring Failures

**File:** `packages/memory-hub/src/config.ts` lines 28–38

**Description:**
The `scrubSecrets()` function (D13) covers:
- `Bearer <token>` patterns
- `sk-...` OpenAI key patterns
- JSON `keypair` and `jwt` fields

It does **not** cover:
- Anthropic API keys (`sk-ant-api03-...` format)
- Google API keys (`AIza...` 39-char format)
- Postgres connection strings with embedded passwords (`postgres://user:PASSWORD@host/db`)

If an Anthropic or Google API key appears in an error stack trace (e.g. from a network error when the key is embedded in an HTTP header in the error message) and that trace reaches `scrubSecrets()` before logging, the key will not be redacted.

The `DATABASE_URL` (which contains `POSTGRES_PASSWORD` inline) is particularly risky: if a DB connection error leaks it in a message like `"connection to server at 'postgres' failed: FATAL: password authentication failed for user 'memory:changeme@postgres'"`, `scrubSecrets()` would not redact the password.

**Severity:** Medium (credential leakage in logs under error conditions)

**Recommendation:**
Extend `scrubSecrets()`:
```typescript
// Anthropic API keys
.replace(/\bsk-ant-api\d\d-[A-Za-z0-9\-_]{10,}/g, 'sk-ant-[REDACTED]')
// Google API keys (AIza prefix, 39 chars)
.replace(/\bAIza[A-Za-z0-9\-_]{35}/g, 'AIza[REDACTED]')
// Postgres DSN passwords: postgres://user:PASSWORD@host
.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/g, '$1[REDACTED]$3')
```

---

### LOW-1: DNS Rebinding Not Mitigated at Application Level — A10 (SSRF)

**OWASP:** A10:2021 Server-Side Request Forgery

**File:** `packages/memory-hub/src/ingest/fetcher.ts` lines 93–100

**Description:**
`validateSsrf()` checks the URL hostname at call time. The code correctly documents this as a known limitation:

```typescript
// LIMITATION — DNS rebinding: this check validates the hostname/IP at call time.
// If a public hostname resolves to a private IP at request time (DNS rebinding),
// this check is bypassed.
```

A DNS rebinding attack: attacker registers `evil.attacker.com`, passes `validateSsrf()` (resolves to public IP), changes DNS TTL to 0, by the time the fetch() call occurs the hostname resolves to `169.254.169.254` (AWS metadata endpoint).

This is correctly documented and the recommendation (network-level egress firewall) is the proper mitigation. The finding is LOW because:
- The documentation is accurate
- The defense-in-depth posture is explicitly stated
- Production deployments with `iptables DROP for RFC1918` would be protected

**Severity:** Low (documented known limitation, requires network-level fix)

**Recommendation:** Already documented. Add to deployment README: "Cloud deployments MUST configure `iptables -A OUTPUT -d 169.254.0.0/16 -j DROP` (and RFC1918 ranges) to mitigate DNS rebinding. The application-level SSRF check is defense-in-depth, not the primary control."

---

### LOW-2: `ipv6HasPrefix()` Has Incomplete IPv6 Parsing for Compressed Addresses — A10 (SSRF)

**OWASP:** A10:2021 Server-Side Request Forgery

**File:** `packages/memory-hub/src/ingest/fetcher.ts` lines 72–84

**Description:**
The `ipv6HasPrefix()` function attempts to check IPv6 CIDR membership by comparing hex character prefixes after removing colons:

```typescript
const rawCompact = raw.replace(/:/g, "");
const prefixCompact = prefixHex.replace(/:/g, "");
// ...
return rawPrefix.startsWith(expectedPrefix.slice(0, Math.floor(prefixBits / 4)));
```

This approach fails for **compressed IPv6 addresses** with `::` elision. For example:
- `fe80::1` becomes `fe801` after `replace(/:/g, "")` — only 5 chars, but a full fe80:: address has 16 bytes = 32 hex chars
- The comparison `rawCompact.startsWith("fe")` works in this specific case
- However `fc::1` (ULA) becomes `fc1` which matches `fc` prefix correctly by coincidence

The real risk: `::` compressed addresses where the important bits are NOT in the leading position. Example: an attacker crafts `2000:0:0:0:0:0:0:fc00` (starts with 2, passes the "public unicast" check on line 131) but this is actually a valid public unicast address, not a bypass. The real bypass would require an address starting with 2 or 3 that routes to a private destination, which is impossible in the SSRF threat model (the destination is a public IP).

The existing explicit checks for `::1`, `fc`, `fd`, `fe8/9/a/b` prefixes handle the critical cases correctly. The gap is only in the `ipv6HasPrefix()` helper which is used as an additional belt-and-suspenders check for `fc00::/7`.

**Severity:** Low (practical exploitability is negligible; the belt-and-suspenders structure of the IPv6 checks compensates)

**Recommendation:** Replace `ipv6HasPrefix()` with a proper IPv6 expansion library or use the Node.js `net` module:
```typescript
import { isIPv6 } from 'node:net';
// Expand :: notation before hex comparison, or use Buffer-based 128-bit integer comparison
```

---

### LOW-3: `MnemonikAdapter.recall()` Not Exposed as MCP Tool but Present as Attack Surface — A01 (Broken Access Control)

**OWASP:** A01:2021 Broken Access Control

**File:** `packages/memory-hub/src/adapters/mnemonik.ts` lines 80–88

**Description:**
`MnemonikAdapter.recall()` makes network calls to the Mnemonik service (`this.client.recall()`). It is NOT wired into any MCP tool handler in `server.ts`. However, it is a public method on the adapter that any future contributor could wire without realizing it introduces a user-controlled query to an external service.

More importantly: `recall()` does not apply `redactJWT()` to its errors (unlike `sign()` and `verify()`). If it is ever wired up, SDK errors would be returned raw.

**Severity:** Low (currently unexposed; preventative)

**Recommendation:** Add `@internal` JSDoc to `recall()` and apply `redactJWT()` to its error handler:
```typescript
/** @internal — not exposed as MCP tool. Do not wire without security review. */
async recall(query: string, topK = 5): Promise<RecallHit[]> {
  try {
    const result = await this.client.recall(query, { topK });
    return result.hits;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(redactJWT(raw));
  }
}
```

---

### LOW-4: `MEMORY_ALLOWED_DIRS` Defaults to `/tmp` in Docker, `~/` in Bare Metal — A05 (Misconfiguration)

**OWASP:** A05:2021 Security Misconfiguration

**Files:** `docker-compose.yml` line 71, `packages/memory-hub/src/ingest/file.ts` line 82, `.env.example` line 103

**Description:**
There is a significant difference in the default `MEMORY_ALLOWED_DIRS` between deployment contexts:

- **Bare-metal / local mode:** defaults to `homedir()` (user home `~/`) — allows reading any file the user owns
- **Docker Compose:** `MEMORY_ALLOWED_DIRS: /tmp` — correctly restricts to `/tmp` inside the container

The inconsistency could confuse operators who run memory-hub bare-metal in cloud mode (without Docker). They would have a wider filesystem allowlist than the Docker deployment, potentially allowing `memory_capture` of cloud credentials if a LLM agent passes a file path like `~/.aws/credentials`.

**Severity:** Low (requires a malicious or compromised MCP client; documented in .env.example)

**Recommendation:** Add a warning to the README/setup script: "When running bare-metal in cloud mode, set `MEMORY_ALLOWED_DIRS` explicitly to restrict file ingestion. Default `~/` is intentional for local mode but too broad for network-exposed deployments."

---

## Decision Verification

### D8: Content Size Limits — VERIFIED PASS

- `MAX_CONTENT_BYTES = 10 * 1024 * 1024` (10MB) in `ingest/pipeline.ts:23` — correct
- `MAX_IMAGE_BYTES = 5 * 1024 * 1024` (5MB) in `ingest/pipeline.ts:26` — correct
- `ContentTooLargeError` class defined at `pipeline.ts:35` with correct `code: "content_too_large"` and `maxBytes` fields
- Image check uses `base64Part.length` (raw string length, not decoded bytes) — conservative and correct per decisions log
- Text size check applied AFTER URL fetch and file read (`pipeline.ts:190`) — covers all code paths
- Image files read from disk also checked against `MAX_IMAGE_BYTES` (`pipeline.ts:172`)
- `MAX_BODY_BYTES` in `fetcher.ts:25` matches 10MB — consistent
- Fetcher also checks `Content-Length` header before reading body (`fetcher.ts:315–318`) — early rejection

**Gap noted (informational):** The `client_max_body_size 11m` in nginx provides a correct 1MB headroom. However, `memory_capture` with a very large `content` field sent directly as a JSON string would be checked by nginx body size limit, not the application-level check. The application check fires inside `ingest/pipeline.ts` AFTER the JSON is parsed — consistent behavior.

---

### D10: Bearer Token Timing-Safe Comparison — VERIFIED PASS

`mcp/auth.ts` implementation is correct:

1. `authHeader.startsWith("Bearer ")` prefix check first — short-circuits on malformed headers
2. Both buffers zero-padded to `maxLen = Math.max(providedBuf.length, expectedBuf.length)` using `Buffer.alloc(maxLen)` + `.copy()`
3. `timingSafeEqual(a, b)` called on equal-length padded buffers — never throws
4. `lengthsMatch = providedBuf.length === expectedBuf.length` checked separately — prevents a shorter token that matches after padding from succeeding
5. Return value is `lengthsMatch && contentMatch` — both conditions required
6. `create401Response()` never includes token hint or expected key

The nginx layer uses `if ($http_authorization = "Bearer $memory_api_key")` which is NOT timing-safe (noted in nginx comments and D10 rationale). This is explicitly documented and accepted; HTTPS channel protects the transport layer, and memory-hub re-validates with `timingSafeEqual` as defense-in-depth. Architecture is correct.

**One concern (informational):** If `expectedKey` is an empty string (`MEMORY_API_KEY=""` somehow bypassing server.ts exit), `validateBearer()` with `Authorization: Bearer ` would return `true` (both empty strings match). However `server.ts:257–261` calls `process.exit(1)` if `MEMORY_API_KEY` is not set in cloud mode, preventing this path.

---

### D11: SSRF and Path Traversal Mitigations — VERIFIED PASS

**SSRF (fetcher.ts):**
- Scheme check: only `http:` and `https:` allowed — correct
- IPv6 loopback `::1` — blocked
- IPv6 ULA `fc00::/7` — blocked via `bare.startsWith("fc") || bare.startsWith("fd")`
- IPv6 link-local `fe80::/10` — blocked via `fe8/fe9/fea/feb` prefix checks
- Non-public IPv6 catch-all — blocked (only `2xxx/3xxx` pass)
- IPv4 loopback `127.0.0.0/8` — blocked via `ipv4InCidr()`
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` — all blocked
- `localhost` hostname — explicitly blocked
- Max 3 redirects manually followed — each redirect target re-validated via `validateSsrf()`
- 30s timeout via `AbortController`

**SSRF gaps (LOW-1, LOW-2 above):** DNS rebinding (documented) and IPv6 compressed address parsing (minor, belt-and-suspenders only).

**Unblocked address spaces (informational):**
- `0.0.0.0/8` — not blocked. `0.0.0.0` is the "any" address; fetching it would likely fail at the network layer but is not explicitly blocked.
- `100.64.0.0/10` (CGNAT / shared address space) — not blocked. Unlikely to be an internal service but could be in some cloud configurations.

**Path Traversal (file.ts):**
- `expandTilde()` — correct `~` expansion before all path operations
- `resolveInputPath()` — converts to absolute before checks
- `assertPathAllowed()` (pre-realpath) — path oracle defense; prevents distinguishing "not found" vs "not allowed" for paths like `/etc/passwd`
- `realpathSync()` — resolves all symlinks
- `assertPathAllowed()` (post-realpath) — the security-effective check; catches `~/evil-symlink → /etc/passwd`
- Two-check design is correct: pre-check defends against path-oracle, post-check defends against symlink escape

**Normalization concern (informational):** `assertPathAllowed()` uses `.replace(/\\/g, "/")` for Windows normalization. On Linux (the deployment target), this is unnecessary but harmless. There is no URL-encoding or null-byte attack surface in `node:path` resolution.

---

### D12: Structured Prompts / LLM Prompt Injection — PARTIAL

**OWASP:** A03:2021 Injection (LLM Prompt Injection)

**Files:** `storage/local.ts` lines 41–79, `storage/cloud.ts` lines 138–175

**What is implemented:**
- `memory_think` calls `runThink(engine, { question })` — the synthesis is delegated entirely to gbrain's internal think pipeline
- BM25-only mode returns a static string (no LLM called, no injection risk)
- Errors from `runThink()` are caught and returned as `{ answer: "Synthesis failed: ...", citations: [], gaps: [] }` — no raw LLM output leakage

**Gap — gbrain's internal prompt structure not audited:**
D12 specifies "clearly delimited sections: `<memory_context>` tags wrapping retrieved chunks" and "system-level prompt, not concatenated with user content." These are gbrain internal behaviors. The memory-hub code passes only `{ question }` to `runThink()` — it has no control over how gbrain constructs the LLM prompt.

- If gbrain uses a system prompt with `<memory_context>` delimiters for injected chunks, D12 is satisfied
- If gbrain concatenates user question directly with retrieved memory chunks without delimiters, prompt injection from captured content is possible

**Verification needed:** Audit `vendors/gbrain/src/core/think/index.ts` to confirm that the synthesis prompt correctly separates system instructions from user question and retrieved context. This is out of scope for this audit (gbrain is a vendor library) but should be part of a gbrain security review.

**Severity of gap:** Medium in principle, but mitigated by:
1. Single-user deployment — the "attacker" would be the user themselves (self-injection)
2. The synthesized output is returned to the MCP client (the user), not executed as code
3. Response structure validation (gbrain returns typed `ThinkResult`) catches obvious format-altering injections

**Recommendation:** Add a `question.slice(0, 4096)` length guard on the `memory_think` input to cap the question passed to the LLM (prevents prompt exhaustion attacks). Document gbrain's prompt structure in the security decisions or perform a targeted review of `vendors/gbrain/src/core/think/`.

---

### D13: Secret Protection in Logs — VERIFIED PASS

**config.ts:**
- `scrubSecrets()` covers Bearer tokens, `sk-...` API keys, JSON `keypair` and `jwt` fields
- `maskKey()` shows only last 4 chars of API keys in startup logs
- `MEMORY_API_KEY` value never printed — only `"(set)"` at `server.ts:272`
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` values never printed raw — only `maskKey()` representation

**mcp/http.ts:**
- Error messages scrubbed via `scrubSecrets()` before `process.stderr.write()` at lines 95, 104

**adapters/mnemonik.ts:**
- `redactJWT()` applied to all error strings before logging in `createMnemonikAdapter()` at line 133
- Startup warnings never include raw JWT or keypair values

**tools/sign.ts:**
- `redactJWT()` applied to signing errors at line 114
- DB errors logged without secret content (content hash only, not the content itself)

**tools/verify.ts:**
- `redactJWT()` applied to verify errors at line 46

**Gap (MEDIUM-3 above):** `scrubSecrets()` does not cover Anthropic/Google key patterns or Postgres DSN passwords.

**Docker Compose (docker-compose.yml):**
- `POSTGRES_PASSWORD` injected via `${POSTGRES_PASSWORD:?...}` — required, not defaulted to empty
- `DATABASE_URL` assembled from vars — password embedded in URL is a standard pattern
- No secrets printed in healthcheck commands

**nginx:**
- API key stored in separate `/etc/nginx/memory-secrets.conf` (not in the repo)
- `.gitignore` should include this file — verified not present in repo (gitignored)

---

## Additional Findings — Areas Not Covered by D8/D10/D11/D12/D13

### Security Headers — GOOD

nginx `memory.conf` correctly sets:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — strong HSTS
- `X-Content-Type-Options: nosniff` — MIME sniffing protection
- `X-Frame-Options: DENY` — clickjacking protection
- `Referrer-Policy: no-referrer` — referrer leak prevention
- `server_tokens off` — nginx version disclosure prevention

Missing: `Content-Security-Policy` header. Not critical for an API-only endpoint (no HTML served), but worth adding as defense-in-depth: `Content-Security-Policy: default-src 'none'`.

### SQL Injection — PASS

All SQL in `tools/sign.ts` uses parameterized queries:
```typescript
db.query("SELECT ... WHERE content_hash = $1 LIMIT 1", [hash])
db.query("INSERT ... VALUES ($1, $2, $3, $4) ON CONFLICT ...", [...])
```
DDL in `cloud.ts:101–109` is a static string template with no user interpolation — safe.
gbrain's own query layer (via `engine.search()`, `engine.upsert()`, etc.) is a vetted library — trust boundary is clear.

### Dependency Vulnerabilities

Bun's lockfile format (`bun.lock`) is not compatible with `npm audit`. A manual review of declared dependencies:

| Package | Version | Known Issues |
|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | ^1.0.0 | No known CVEs as of audit date |
| `@mozilla/readability` | ^0.6.0 | No known CVEs; actively maintained |
| `jsdom` | ^29.1.1 | No critical CVEs in 29.x |
| `pdf-parse` | ^2.4.5 | No known CVEs in v2.x |
| `@mnemonik-xyz/sdk` | latest | Pinned to `latest` — **risk**: future version could introduce breaking changes or vulnerabilities without a lockfile pin |

**Recommendation:** Pin `@mnemonik-xyz/sdk` to a specific semver range (`^x.y.z`) rather than `latest`. Running `bun audit` periodically (once Bun supports it) or using a CI-integrated dependency scanner is advised.

### Authentication — PASS (with noted limitations)

Single-user deployment with static Bearer token is appropriate for the described use case. The multi-layer auth (nginx primary + memory-hub defense-in-depth) is correct. No session management, no OAuth — consistent with the single-user spec.

**Future multi-user risk:** The `user_id` parameter on every tool is passed through to gbrain but there is no authentication of `user_id`. A caller who knows another user's `user_id` string can search/list/delete that user's memories. This is by design for the current single-user architecture but must be addressed before any multi-user deployment.

### Python Eval Adapter (packages/eval/) — PASS with note

`_McpStdioClient` spawns `bun run <path>` with `env` dict. The path is a hardcoded repo path (`_SERVER_ENTRY`), not user-controlled. No shell injection possible. The `json.loads()` calls in `_recv_line()` have no prototype pollution risk in Python. JSON deserialization from a controlled subprocess is safe.

---

## Summary Table

| ID | Severity | OWASP Category | File | Status |
|----|----------|----------------|------|--------|
| MEDIUM-1 | Medium | A03 Injection / A04 Insecure Design | `mcp/server.ts:177,214` | No bounds on numeric tool args |
| MEDIUM-2 | Medium | A04 Insecure Design / A05 Misconfiguration | `mcp/server.ts` | No rate limiting in local/stdio mode |
| MEDIUM-3 | Medium | A09 Logging Failures | `config.ts:28–38` | `scrubSecrets()` gaps for Anthropic/Google/DSN |
| LOW-1 | Low | A10 SSRF | `ingest/fetcher.ts:93–100` | DNS rebinding (documented limitation) |
| LOW-2 | Low | A10 SSRF | `ingest/fetcher.ts:72–84` | IPv6 compressed address parsing |
| LOW-3 | Low | A01 Broken Access Control | `adapters/mnemonik.ts:80–88` | `recall()` missing `redactJWT()` |
| LOW-4 | Low | A05 Misconfiguration | `docker-compose.yml:71` | `MEMORY_ALLOWED_DIRS` default inconsistency |
| INFO | Info | A07 Auth | `mcp/server.ts:55,69` | `user_id` unauthenticated (by design, single-user) |

---

## Decisions Not Implemented (Gaps from Spec)

**D12 response structure validation:** The tech-spec states "malformed response → retry once, then error." This retry logic is not implemented — `runThink()` errors are caught and returned as `Synthesis failed: ...` without retry. This is a hardening gap (not a security vulnerability) but reduces resilience against prompt-injection-induced format corruption. Recommend opening a task to add single-retry on `ThinkResult` shape validation failure.

---

## Conclusion

The universal-memory-system demonstrates strong security discipline in its core attack surfaces. D10 (timing-safe auth), D11 (SSRF+path traversal), and D13 (secret scrubbing) are correctly implemented. D8 (content limits) is thorough and conservative. D12 is partially implemented with the structural isolation depending on gbrain's internal prompt design.

Recommended immediate actions:
1. Fix MEDIUM-1: add bounds to `top_k` and `limit` parameters
2. Fix MEDIUM-3: extend `scrubSecrets()` to cover Anthropic/Google key and DSN patterns
3. Pin `@mnemonik-xyz/sdk` to a semver range

All other findings are low/informational and appropriate for a post-launch hardening sprint.
