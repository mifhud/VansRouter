# Conventions

## Code Style

- **ESM imports**: Always use `.js` extension explicitly (`import x from './foo.js'`)
- **No JSX in server code**: API routes, `open-sse/`, `src/lib/`, `src/sse/` are plain Node ESM
- **File naming**: kebab-case for files (`chat-handler.js`), PascalCase for React components
- **Export style**: Named exports preferred, default exports for Next.js routes/pages

## Linting

- **no-undef enforced** in:
  - `src/app/api/**/*.js` (API routes)
  - `open-sse/**/*.js` (SSE engine)
  - `src/lib/**/*.js`, `src/sse/**/*.js` (server utilities)
  - `src/app/(dashboard)/**/*.js` (dashboard client components)
- **React Hooks rules**: enforced via `lint:reacthooks` script
- **Ignored dirs**: `.next/`, `node_modules/`, `cli/app/.next/`, build artifacts

## Architecture Patterns

### Config-Driven

- **Never hardcode** provider names, model IDs, endpoints, or feature flags
- **Constants location**:
  - `open-sse/config/` — SSE engine constants (providers, models, runtime)
  - `src/shared/constants/` — Next.js app constants (providers, models for UI)
- **DRY principle**: Reuse `translator/schema/`, `translator/concerns/`, `translator/formats/`

### Provider Registry

- New providers → `open-sse/providers/registry/{id}.js`
- Copy `REGISTRY_TEMPLATE`, add models to `providerModels.js`
- Regenerate index after adding

### Translator Pattern

- **Request translator**: `open-sse/translator/request/<from>-to-<to>.js`
- **Response translator**: `open-sse/translator/response/<from>-to-<to>.js`
- Register via `register(from, to, fn)` and import in `translator/index.js`

### API Routes (Next.js App Router)

- Location: `src/app/api/{path}/route.js`
- Export: `GET`, `POST`, etc. as named exports
- Return: `Response` objects (Web API)

### Dashboard UI

- Location: `src/app/(dashboard)/dashboard/{page}/`
- Must be client components (`'use client'`)
- Use Zustand for state, Material Symbols for icons

## Naming Conventions

- **Files**: kebab-case (`chat-handler.js`, `token-refresh.js`)
- **React components**: PascalCase files + exports (`ApiKeyCard.js` → `export default ApiKeyCard`)
- **Functions**: camelCase (`handleChatRequest`, `translateResponse`)
- **Constants**: SCREAMING_SNAKE_CASE for true constants (`MAX_RETRIES`), camelCase for config objects
- **Providers**: lowercase slugs (`openai`, `anthropic`, `gemini`)
- **Models**: provider-prefixed (`openai/gpt-4`, `anthropic/claude-3-opus`)

## Directory Organization

- **Modality separation**: Each modality (chat, image, tts, stt, embedding) has:
  - Handler: `src/sse/handlers/{modality}.js` (auth, model resolution, retry)
  - Core: `open-sse/handlers/{modality}Core.js` (translate, execute)
- **Translator structure**: `request/`, `response/`, `schema/`, `concerns/`, `formats/`
- **Executors**: `open-sse/executors/{name}.js` (subclass `BaseExecutor`)

## Error Handling

- **Auth errors**: 401 with JSON error response
- **Provider errors**: Retry with exponential backoff (configurable)
- **Translator errors**: Log format detection failure, return 500
- **SSE errors**: Send error event, close stream

## Comments

- **Header comments**: Explain WHY for non-obvious logic, workarounds, Windows compat
- **Inline comments**: Rare; prefer self-documenting code
- **TODO comments**: Include issue number if applicable

## Testing

- **Framework**: Vitest
- **Location**: `tests/` directory
- **Suites**: `tests/unit/` (utilities/services), `tests/translator/` (format conversion)
- **Run command**: `pnpm test` (all), `pnpm test tests/unit/` (scoped)
