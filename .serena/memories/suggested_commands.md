# Suggested Commands

## Development

```bash
pnpm install                    # Install dependencies
pnpm run dev                    # Start dev server on port 20127
pnpm run dev:webpack            # Dev with explicit webpack (no Turbopack)
pnpm run dev:bun                # Dev with Bun runtime
```

## Build & Production

```bash
pnpm run build                  # Production build (runs scripts/build.js)
                                # Auto-copies public/ and .next/static to standalone/

# Manual build steps (if not using build script):
next build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static

# Start production server:
pnpm run start                  # Next.js start (port 20127)
# OR with PM2:
PORT=3003 pm2 start .next/standalone/server.js --name 9router
pm2 save
```

## Linting & Quality

```bash
pnpm run lint                   # Run ESLint
pnpm run lint:undef             # Check for undefined identifiers (via scripts/lint-undef.cjs)
pnpm run lint:reacthooks        # Check React Hooks rules (via scripts/lint-reacthooks.cjs)
```

## Testing

```bash
pnpm test                       # Run all tests (Vitest)
pnpm test tests/unit/           # Unit tests only
pnpm test tests/translator/     # Translator tests only
```

## CLI Tool

```bash
pnpm run cli:pack               # Build CLI tarball
pnpm run cli:publish            # Publish CLI to npm
```

## Docker

```bash
docker-compose up -d            # Start services (app + deps)
docker-compose down             # Stop services
docker-compose logs -f          # Follow logs
docker build -t 9router .       # Build image
```

## PM2 Management

```bash
pm2 list                        # List processes
pm2 logs 9router                # View logs
pm2 restart 9router             # Restart app
pm2 stop 9router                # Stop app
pm2 delete 9router              # Remove from PM2
pm2 env 9router                 # Show environment variables
pm2 save                        # Save process list
```

## Troubleshooting

```bash
# Check port mismatch (502 errors):
pm2 env 9router | grep PORT

# Verify static assets copied:
ls -la .next/standalone/public
ls -la .next/standalone/.next/static

# Check SQLite DB location (Docker):
docker exec -it <container> ls -la /app/data/db/

# Verify volume mount:
docker volume inspect 9router-data
```

## Git (Linux)

Standard git commands work as-is on Linux. No special considerations needed.
