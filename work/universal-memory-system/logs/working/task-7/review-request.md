# Task 7 Review Request — Docker + nginx + HTTPS infra

**Commit:** 44408e4 (feat: task 7 — Docker + nginx + HTTPS infra)
**Repo:** /home/op/Projects/universal-memory/

## Files created

1. `docker/memory-hub/Dockerfile` — Bun 1.3.10-slim, workspace-aware dep install, `CMD bun run src/mcp/server.ts`
2. `docker-compose.yml` — memory-hub + pgvector/pgvector:pg16 postgres, independent from any Paywall services
3. `nginx/memory.conf` — memory. subdomain, HTTP→HTTPS redirect, Let's Encrypt, Bearer auth at nginx level (D4), /health bypass
4. `.env.example` — all MEMORY_* + MNEMONIC_* + LLM API key vars with inline comments
5. `.dockerignore` — excludes node_modules, .env, docs, research, packages/eval from build context

## Key design decisions to review

- **Workspace layout**: Dockerfile copies `packages/memory-hub/bun.lock` (which has workspace ref to `../../vendors/gbrain`) then runs `bun install --frozen-lockfile` from `/app/packages/memory-hub`. `/app` mirrors repo root so relative path resolves correctly.
- **nginx Bearer auth**: uses `if ($http_authorization = "Bearer $memory_api_key")` with variable set from included `/etc/nginx/memory-secrets.conf`. Not timing-safe (acknowledged in D10), HTTPS channel protects. memory-hub does timing-safe re-check.
- **Health bypass**: `/health` endpoint skips auth — used by Docker healthcheck probes.
- **Ports**: 3456 and 5432 are `expose` only (not `ports`) — nginx is the only entry point.
- **POSTGRES_PASSWORD required**: uses `:?` syntax to fail fast on missing required vars.

## Reviewers

Please write findings to:
- code-reviewer → `/home/op/work/work/universal-memory-system/logs/working/task-7/code-reviewer-round1.json`
- security-auditor → `/home/op/work/work/universal-memory-system/logs/working/task-7/security-auditor-round1.json`
- deploy-reviewer → `/home/op/work/work/universal-memory-system/logs/working/task-7/deploy-reviewer-round1.json`
