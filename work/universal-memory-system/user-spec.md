---
feature: universal-memory-system
status: approved
created: 2026-07-26
---

# Universal Memory System

## Что делаем

Строим **единый MCP-сервер памяти** — хранилище знаний, в которое стекаются все результаты работы AI-инструментов (контексты, исследования, заметки, артефакты, код) и из которого любой AI-агент или клиент может мгновенно получить контекст.

Система состоит из трёх слоёв:

1. **Memory Hub** (`packages/memory-hub/`) — тонкий MCP-сервер поверх gbrain. Экспонирует 7 MCP tools. Работает в двух режимах: `local` (gbrain + PGLite, stdio, для разработки) и `cloud` (gbrain + Postgres, HTTP MCP на VPS, source of truth).

2. **gbrain** (`vendors/gbrain/`) — core engine: hybrid search (vector + BM25 + RRF), synthesis (LLM-ответ с цитатами + gap analysis), knowledge graph, ingestion pipeline. Используется как библиотека через library exports (`gbrain/engine`, `gbrain/search/hybrid`, `gbrain/ingestion`).

3. **Mnemonik signing layer** (опционально) — `@mnemonik-xyz/sdk` поверх cloud режима. `memory_sign` добавляет Ed25519 COSE_Sign1 подпись через `MnemonicClient.signMemory()`, `memory_verify` проверяет через `MnemonicClient.verify()`. Только для cloud — локальное подписывать смысла нет.

**Репозиторий:** `/home/op/Projects/universal-memory/` (уже создан, submodules gbrain + mnemonik добавлены, scaffolding существует, требует реализации).

## Зачем

**Mnemonik protocol** (`mnemonik-xyz/monorepo`) — верифицируемая память для AI-агентов — не имеет слоя хранения и поиска самих воспоминаний. Universal Memory заполняет этот пробел: становится storage backend которого не хватает протоколу.

**Coding Fabric** — попытка построить "one man company" где код пишут агенты — не имеет никакой памяти вообще. Агенты каждый раз начинают с нуля. Universal Memory даёт им накопленный контекст.

**Глобальная цель:** единая память как основа для AI-native разработки — компании одного человека, где агенты пишут код, проводят исследования, принимают решения — и всё это накапливается в одном месте и доступно из любого инструмента.

## Пользователи

- **Разработчик (владелец):** один человек. Использует через любой AI-инструмент с MCP поддержкой — на десктопе, ноутбуке, или мобильном.
- **AI-агенты:** агенты в Claude Code, Kini, KimiClaw (OpenClaw на Kimi), Coding Fabric — вызывают MCP tools в ходе работы (явно по команде или самостоятельно по контексту задачи).
- **Внешние пользователи:** out of scope.

**Клиентские поверхности (все через MCP config, один HTTP endpoint):**
- Claude Code (desktop) → `mcpServers` в `.claude/settings.json`
- Claude mobile → remote MCP через HTTP
- Kini (desktop + mobile) → MCP config
- KimiClaw (OpenClaw на Kimi) → MCP config
- Coding Fabric agents → через Claude Code или KimiClaw runner
- Любой MCP-совместимый инструмент

**Доступ и защита:**
- Один HTTPS endpoint на Hetzner VPS (Let's Encrypt через nginx)
- Один API key в заголовке: `Authorization: Bearer <key>`
- Ключ добавляется один раз в MCP config каждого клиента
- Внешние запросы без ключа → 401

## Флоу

### Захват знания (Capture)

```
Агент (или пользователь) вызывает memory_capture() — явно или самостоятельно:
  → memory_capture({ content: "...", source: "research", tags: ["mnemonik"] })
  → gbrain chunking + embedding + upsert в PGLite (local) или Postgres (cloud)
  → возвращает: { id, chunks }
  → опционально: memory_sign({ id }) → Mnemonik attestationId
```

С точки зрения memory системы явный и неявный захват — один и тот же tool call. Разница только в системном промпте агента на стороне клиента.

**Поддерживаемый контент:** text, URLs (система скачивает), files (PDF, markdown, code), images.

### Поиск (Search)

```
Агент / пользователь перед новой задачей:
  → memory_search({ query: "что мы решили про архитектуру mnemonik?" })
  → gbrain hybrid search: vector similarity + BM25 keyword + RRF fusion
  → возвращает: [{ id, content, score, source, tags }] топ-10
```

### Синтез (Think)

```
Агент / пользователь задаёт вопрос:
  → memory_think({ question: "что нужно знать перед рефакторингом mcp crate?" })
  → gbrain synthesis: поиск релевантных chunks → LLM ответ с цитатами + gap analysis
  → возвращает: { answer, citations: [{id, excerpt}], gaps: ["..."] }
  (gaps = что мозг не знает, на что стоит обратить внимание)
```

### Cloud vs Local

```
LOCAL режим (stdio):
  → gbrain + PGLite (embedded SQLite-backed, zero server)
  → для локальной разработки и dev-агентов
  → ИЗОЛИРОВАННОЕ хранилище: локальные записи НЕ синхронизируются в cloud
  → cloud недоступен → print error (нет silent fallback)

CLOUD режим (HTTP MCP, VPS):
  → gbrain + Postgres (source of truth, всё стекается сюда)
  → HTTP MCP endpoint доступен из любой клиентской поверхности
  → отдельный Docker Compose сервис на Hetzner VPS
  → независимый деплой от Universal Paywall
```

> **Важно:** local и cloud — два независимых хранилища в MVP. Для постоянной памяти используй cloud режим. Sync local → cloud — post-MVP.

### Верификация (Sign / Verify)

```
После capture в cloud:
  → memory_sign({ id, tags?: ["research", "decision"] })
  → MnemonicClient.signMemory(content) → COSE_Sign1 Ed25519 подпись
  → возвращает: { attestationId, signedAt, status }

Проверка:
  → memory_verify({ attestationId })
  → MnemonicClient.verify(attestationId)
  → возвращает: { status: "verified" | "tampered" | "not_found", signer? }
```

## MCP Tools (MVP)

| Tool | Параметры | Возвращает |
|---|---|---|
| `memory_capture` | `content`, `source?`, `tags?` | `{ id, chunks }` |
| `memory_search` | `query`, `top_k?=10` | `[{ id, content, score, source }]` |
| `memory_think` | `question` | `{ answer, citations, gaps }` |
| `memory_sign` | `id`, `tags?` | `{ attestationId, signedAt, status }` |
| `memory_verify` | `attestationId` | `{ status, signer? }` |
| `memory_list` | `limit?=20` | `[{ id, content, source, created_at }]` |
| `memory_delete` | `id` | `{ status: "deleted" }` |

**Установка без прав администратора:** `npx` или `bunx` — без глобальных пакетов, без `sudo`.

**Post-MVP:** plugin-level автозахват (Claude extension), multi-user scoping, UI браузера памяти.

## Критерии приёмки

### MCP Tools

- [ ] `memory_capture(content, source?, tags?)` — инжестирует контент в gbrain, возвращает `{ id, chunks }`. Поддерживает text, URL (auto-fetch), file path, base64 image.
- [ ] `memory_search(query, top_k?=10)` — hybrid search через gbrain (vector + BM25 + RRF), возвращает топ-K с `score`, `source`, `content`.
- [ ] `memory_think(question)` — gbrain synthesis: LLM-ответ с цитатами + gap analysis. Ответ содержит `answer`, `citations[]`, `gaps[]`.
- [ ] `memory_sign(id, tags?)` — вызывает `MnemonicClient.signMemory()`, возвращает `attestationId`. Только в cloud режиме; в local → ошибка `"Signing only available in cloud mode"`. Если Mnemonik service недоступен → ошибка с actionable сообщением (не silent failure). Повторный вызов с тем же id → idempotent (тот же attestationId).
- [ ] `memory_verify(attestationId)` — вызывает `MnemonicClient.verify()`, возвращает discriminated union `verified | tampered | not_found`.
- [ ] `memory_list(limit?=20)` — последние записи с метаданными.
- [ ] `memory_delete(id)` — удаляет запись по id.

### Local режим

- [ ] Запуск через stdio без дополнительных сервисов: `bun run packages/memory-hub/src/mcp/server.ts`
- [ ] **Работает без прав администратора** — никакого `sudo`, никаких системных сервисов, никаких глобальных установок. Bun в `~/.bun/`, данные в `~/.universal-memory/brain/`
- [ ] gbrain PGLite (Postgres-in-WASM) инициализируется автоматически в `~/.universal-memory/brain/` при первом запуске — без системной БД
- [ ] Все 5 инструментов без знака работают в local режиме (capture, search, think, list, delete)
- [ ] `memory_sign` в local режиме → понятная ошибка: "Signing only available in cloud mode"
- [ ] Cloud недоступен → print error, не silent fallback

### Cloud режим

- [ ] HTTP MCP сервер поднимается как отдельный Docker Compose сервис на Hetzner VPS
- [ ] Независимый деплой от Universal Paywall (`docker compose up memory-hub -d`)
- [ ] gbrain + Postgres: все captures попадают в cloud (source of truth)
- [ ] `memory_sign` работает в cloud режиме (требует `MNEMONIC_JWT` + `MNEMONIC_IDENTITY` env vars)
- [ ] HTTPS endpoint доступен через nginx с Let's Encrypt (subdomain `memory.`)
- [ ] Запросы без `Authorization: Bearer <key>` → 401 до обработки MCP
- [ ] Один API key в env var на сервере; ротация через env update + restart

### Клиентская совместимость

- [ ] Работает в **Claude Code**: добавить `mcpServers.universal-memory` в `.claude/settings.json` → все 7 tools доступны
- [ ] Работает в **KimiClaw** (OpenClaw на Kimi): аналогичный MCP config
- [ ] Работает в **Kini**: MCP config
- [ ] Работает в **Coding Fabric** agents через Claude Code runner
- [ ] Один и тот же HTTP endpoint используется всеми cloud-клиентами без дополнительной настройки

### Качество поиска и синтеза (RUMBA)

- [ ] RUMBA benchmark (`packages/eval/`) прогоняется против universal-memory backend
- [ ] `RecallAccuracy@5` ≥ mem0 baseline на стандартном RUMBA датасете (результаты базовых прогонов фиксируются в `research/RUMBA/results/baselines.json` перед запуском нашего eval)
- [ ] `AnswerQuality` synthesis score ≥ 0.7 (LLM judge по RUMBA rubric: релевантность 0–1, точность цитат 0–1, полнота gap analysis 0–1; среднее по 3 вопросам)
- [ ] Результаты benchmark зафиксированы в `research/RUMBA/results/universal-memory.json`

### Integration Tests

- [ ] Каждый MCP tool покрыт integration test: вызов tool → проверка ответа
- [ ] E2E сценарий 1: capture из Claude Code → search из KimiClaw → получить результат
- [ ] E2E сценарий 2: capture → memory_think → ответ содержит citations
- [ ] E2E сценарий 3: capture в cloud → memory_sign → memory_verify → status: "verified"
- [ ] E2E сценарий 4: Coding Fabric agent вызывает memory_capture + memory_think в ходе задачи

### Интеграция с Mnemonik и Fabric

- [ ] Mnemonik protocol агенты могут использовать universal-memory как storage backend: `mnemonic_sign_memory` → `memory_capture` + `memory_sign`
- [ ] Coding Fabric CLAUDE.md / агенты имеют MCP config для universal-memory
- [ ] `adapters/fabric/patterns/memory_capture/` и `memory_recall/` patterns работают через universal-memory MCP

## Что не входит в MVP

- Внешний доступ для других пользователей (multi-user scoping)
- Plugin-level автозахват (Claude extension, автоматический захват без явного tool call)
- UI для просмотра и управления памятью (браузер воспоминаний)
- Mobile app
- Load testing / performance benchmarks
- Голосовой ввод
- Sync local → cloud (local и cloud — независимые хранилища в MVP; cloud = source of truth)
