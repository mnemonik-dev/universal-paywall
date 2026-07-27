# Execution Plan: Universal Memory System

**Feature:** universal-memory-system  
**Total waves:** 8  
**Total tasks:** 14  
**Repo:** /home/op/Projects/universal-memory/

---

## Wave 1 — Foundation (parallel)

| Task | Teammate | Reviewers | Verify |
|------|----------|-----------|--------|
| T1: config + gbrain patch + LocalAdapter synthesis | foundation-engineer | code-reviewer, security-auditor, test-reviewer | smoke |
| T2: HTTP MCP transport + Bearer auth | http-transport-engineer | code-reviewer, security-auditor, test-reviewer | smoke |

**Unblocks:** Wave 2

---

## Wave 2 — Ingestion pipeline

| Task | Teammate | Reviewers | Verify |
|------|----------|-----------|--------|
| T3: Multi-content-type ingestion (URL/file/image) | ingest-engineer | code-reviewer, security-auditor, test-reviewer | smoke |

**Unblocks:** Wave 3

---

## Wave 3 — MCP tool handlers (parallel)

| Task | Teammate | Reviewers | Verify |
|------|----------|-----------|--------|
| T4: rename memory_clear→delete + handler integration tests | tools-engineer-a | code-reviewer, test-reviewer | smoke |
| T5: fix LocalAdapter.synthesize() + CloudAdapter | tools-engineer-b | code-reviewer, test-reviewer | smoke |

**Unblocks:** Wave 4 (T6) + Wave 5 (T7 after both T4+T5)

---

## Wave 4 — Mnemonik integration (parallel with Wave 3 completion)

| Task | Teammate | Reviewers | Verify |
|------|----------|-----------|--------|
| T6: idempotency + sign/verify tools + memory_attestations migration | mnemonik-engineer | code-reviewer, security-auditor, test-reviewer | smoke |

**Depends on:** T1, T2  
**Unblocks:** Wave 6 (T8)

---

## Wave 5 — Infrastructure

| Task | Teammate | Reviewers | Verify |
|------|----------|-----------|--------|
| T7: Docker Compose + nginx + HTTPS | infra-engineer | code-reviewer, security-auditor, deploy-reviewer | smoke |

**Depends on:** T4, T5  
**Unblocks:** Wave 6

---

## Wave 6 — Tests + RUMBA (parallel)

| Task | Teammate | Reviewers | Verify |
|------|----------|-----------|--------|
| T8: Unit + integration test suite (≥80% coverage) | test-engineer | code-reviewer, test-reviewer | smoke |
| T9: RUMBA eval harness + client config docs (4 surfaces) | eval-engineer | code-reviewer, test-reviewer | smoke |

**Depends on:** T4, T5, T6, T7 (T8) / T4, T5, T7 (T9)  
**Unblocks:** Wave 7 (Audit)

---

## Wave 7 — Audit (parallel)

| Task | Teammate | Reviewers |
|------|----------|-----------|
| T10: Code Audit → audit-code.md | code-auditor | none |
| T11: Security Audit → audit-security.md | security-auditor | none |
| T12: Test Audit → audit-tests.md | test-auditor | none |

**Depends on:** T8, T9  
**Note:** If auditors find issues → ad-hoc fixer agent spawned with relevant reviewers (max 3 rounds)

---

## Wave 8 — Final (sequential)

| Task | Teammate | Verify |
|------|----------|--------|
| T13: Pre-deploy QA (all ACs, local + cloud modes) | qa-engineer | smoke |
| T14: Deploy to VPS + client config for 4 surfaces | deploy-engineer | smoke |

**Depends on:** T13 → T14

---

## User Checks (after Wave 8)

1. Verify `https://memory.yourdomain.com/mcp` returns 7 tools with your Bearer key
2. Add MCP config to Claude Code `.claude/settings.json` → test `memory_capture("hello")` → `memory_search("hello")`
3. Check `bunx universal-memory setup` suggests Ollama when no LLM key set
4. Verify README quickstart is accurate

---

## Key Decisions to Watch

- **DEV-1**: BM25-only mode when no LLM key (T1) — test all 3 paths (no key / Ollama / cloud key)
- **Mirages fixed**: `ThinkResult` not ThinkResponse, `http-transport.ts` not serve-http.ts, `ParsedCitation.page_slug` mapping
- **gbrain patch**: `./think` export added to vendors/gbrain/package.json (T1)
- **Task 4**: handlers already implemented — focus is rename + integration tests
- **Task 6**: adapter 90% done — focus is idempotency + `memory_attestations` table
