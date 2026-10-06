# Tech Stack

## Framework & Runtime

- **Next.js 16.1.6** — App Router, standalone output
- **React 19.2.4** — with React DOM 19.2.4
- **Node.js** — ESM throughout (`.js` extensions required)
- **Package manager**: `pnpm` with workspace support

## Build & Development

- **Next.js compiler**: Default (Turbopack optional in dev)
- **Bundler**: webpack (configured in `next.config.mjs`)
- **CSS**: Tailwind CSS 4 + PostCSS
- **Linter**: ESLint 9 + `eslint-config-next`
- **Build script**: `scripts/build.js` (handles Windows EPERM workaround + static asset copy)

## Database

- **SQLite** via `better-sqlite3` (optional dep) with `sql.js` WASM fallback
- **Docker volume**: `9router-data` → `/app/data/db/data.sqlite`
- No ORM — direct SQL queries

## Key Dependencies

- **Auth**: `jose` (JWT), `bcryptjs` (password hashing)
- **HTTP**: `express` (custom server), `http-proxy-middleware`, `undici` (fetch)
- **UI**: `@xyflow/react`, `@dnd-kit/*`, `recharts`, Monaco Editor
- **Utilities**: `uuid`, `zustand`, `marked`, `dompurify`, `confbox`
- **Testing**: Vitest

## Deployment

- **Production**: PM2 managing `.next/standalone/server.js`
- **Docker**: Multi-stage build with standalone output
- **Ports**: 
  - Dev: 20127 (configurable via `--port`)
  - Prod: 3003 default (via `PORT` env)

## Version Constraints

- Node.js: ESM + `import.meta.url` support required
- `better-sqlite3`: Optional (build tools needed), `sql.js` used if unavailable
- React 19: Breaking changes from 18 (see React upgrade notes if issues)

## Build Artifacts

- **Output dir**: `.next/` (or `NEXT_DIST_DIR` env override)
- **Standalone bundle**: `.next/standalone/`
- **Manual copies required**: `public/` → `.next/standalone/public/`, `.next/static/` → `.next/standalone/.next/static/`
- **Tracing root**: Project root (or workspace root for CLI builds via `NEXT_TRACING_ROOT_MODE=workspace`)

## Config Files

- `next.config.mjs` — Next.js config (rewrites, headers, webpack customization)
- `eslint.config.mjs` — ESLint flat config
- `postcss.config.mjs` — PostCSS + Tailwind
- `jsconfig.json` — Path aliases
- `pnpm-workspace.yaml` — Monorepo setup (includes `cli/`)
- `docker-compose.yml` — Local Docker dev stack
