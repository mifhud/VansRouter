# Task Completion

Before marking a coding task as complete, run the following verification steps:

## 1. Linting (Required)

```bash
pnpm run lint
```

**Must pass** with zero errors. Warnings are acceptable if pre-existing.

### Specific Lint Checks

For server-side code changes (API routes, `open-sse/`, `src/lib/`, `src/sse/`):
```bash
pnpm run lint:undef
```

For React component changes:
```bash
pnpm run lint:reacthooks
```

## 2. Testing (Required if tests exist)

```bash
# Run all tests:
pnpm test

# Or scope to relevant test suites:
pnpm test tests/unit/           # For utility/service changes
pnpm test tests/translator/     # For translator changes
```

**Must pass** all tests that were passing before your changes.

**If tests fail**:
- Run tests BEFORE your changes to establish baseline
- Compare before/after results
- Fix failures caused by your changes
- Document pre-existing failures (do not suppress)

## 3. Build Verification (Required for structural changes)

If you modified:
- `next.config.mjs`
- `package.json` dependencies
- File structure (moved/renamed files)
- Import paths

Run a production build:
```bash
pnpm run build
```

**Must succeed** without errors.

## 4. Manual Verification (Context-Dependent)

### For API/SSE changes:
- Test the endpoint with a real request (curl/Postman)
- Verify SSE stream produces expected events
- Check error handling (invalid auth, bad provider, etc.)

### For UI changes:
- Start dev server: `pnpm run dev`
- Load affected pages in browser
- Verify visual changes match requirements
- Test interactions (clicks, form submissions)

### For provider/translator changes:
- Run translator tests: `pnpm test tests/translator/`
- If new provider: verify registry includes it
- If new model: verify it appears in model list

## 5. Git Check (Before commit)

```bash
git status                      # Review changed files
git diff                        # Review changes
```

**Verify**:
- Only intended files are modified
- No debug code, console.logs, or TODOs left behind
- No credentials or secrets in diff
- Changes match the task scope

## Completion Criteria

Task is complete when:
1. ✅ All linting passes
2. ✅ All relevant tests pass (compare before/after if failures exist)
3. ✅ Build succeeds (if structural changes made)
4. ✅ Manual verification performed (if applicable)
5. ✅ Git diff reviewed and clean

## Red Flags (Do NOT mark complete)

- ❌ Claiming "should work" without running tests
- ❌ Skipping lint because "it's just a small change"
- ❌ Suppressing test failures without investigation
- ❌ Assuming pre-existing failures without proof (run tests on baseline)
- ❌ Committing console.log debug statements
- ❌ Leaving TODO comments without context

## Evidence Required

When reporting completion, provide:
- Lint output (or confirm zero errors)
- Test results (pass count, duration)
- Build success confirmation (if applicable)
- Manual verification summary (what you tested, what worked)

**No assumptions. No "should work". Only verified results.**
