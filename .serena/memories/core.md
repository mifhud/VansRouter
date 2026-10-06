# 9router Core

**Universal AI API proxy**: OpenAI-compatible endpoint → 100+ providers (LLM, image, TTS, STT, embedding, search).

## Architecture

```
Client (OpenAI format) → /api/v1/* → SSE handlers → Translator → Executor → Provider
                                                                    ↓
                              Response ← Translator (provider → client format)
```

## Directory Map

- `src/` — Next.js app (App Router)
  - `app/` — routes (dashboard UI + API endpoints)
  - `lib/` — DB, OAuth, utilities
  - `shared/` — constants, components, hooks
  - `sse/handlers/` — SSE request handlers (chat, tts, image, etc)
- `open-sse/` — provider-agnostic SSE engine (translator, executors, handlers, services)
- `cli/` — CLI tool
- `tests/` — Vitest test suites
- `scripts/` — build/deploy helpers
- `public/` — static assets

## Request Flow (Chat Example)

1. `src/sse/handlers/chat.js` — auth, model resolution, retry loop
2. `open-sse/handlers/chatCore.js` — translate, inject RTK/Caveman/Ponytail, execute
3. `open-sse/translator/` — format conversion (OpenAI ↔ Claude/Gemini/Kiro/etc)
4. `open-sse/executors/` — per-provider HTTP calls

## Key Invariants

- **Config-driven**: ALL constants in `open-sse/config/` and `src/shared/constants/`. Never hardcode.
- **ESM everywhere**: All imports use `.js` extension explicitly.
- **Standalone output**: Next.js builds to `.next/standalone/` + manual static asset copy.
- **SQLite DB**: `better-sqlite3` (preferred) with `sql.js` fallback. Docker volume `9router-data` → `/app/data` (NEVER rename without migration).

## Custom Features

- **ACL per API key**: `allowedProviders`, `allowedCombos`, `allowedKinds`
- **Token Saver**: RTK (compress tool output) + Caveman (terse output) + Ponytail (YAGNI code)
- **Combo strategies**: Fallback, Round Robin, Fusion (parallel + judge), Capacity auto-switch
- **Provider nodes**: Custom OpenAI/Anthropic-compatible providers with UUID suffix

## Critical Files

| File | Purpose |
|------|---------|
| `src/shared/constants/providers.js` | Provider definitions, aliases, ACL list |
| `src/shared/constants/models.js` | Model definitions per provider |
| `open-sse/config/providers.js` | Provider registry build |
| `open-sse/handlers/chatCore.js` | Core chat handler (RTK/Caveman/Ponytail injection) |
| `src/sse/services/auth.js` | API key validation, ACL checks |
| `src/sse/services/allowedModels.js` | Model access control |

## Sub-domains

- `mem:tech_stack` — framework versions, build tools
- `mem:conventions` — code style, naming, patterns
- `mem:suggested_commands` — dev/test/lint/build commands
- `mem:task_completion` — verification steps before marking work done

## Behavioral Rules (MANDATORY)

1. **No assumptions without evidence** — never claim "fixed" without test output/diff
2. **Be skeptical** — verify tests actually test what you think
3. **Never fabricate reports** — don't claim "all tests pass" without running them
4. **Distinguish pre-existing vs caused-by-change with proof** — run tests before AND after
5. **Report honestly** — if broken and can't fix, say so
6. **Verify before done** — run relevant tests AFTER changes
7. **Docker DB volume persistent** — never rename `9router-data` without explicit migration

## Deployment Guides

- Production: `agent.md` (Indonesian)
- Docker: `DOCKER.md`
- Full architecture: `AGENTS.md` (this file)
- SSE engine: `open-sse/AGENTS.md`
- Translator tests: `tests/translator/AGENTS.md`
