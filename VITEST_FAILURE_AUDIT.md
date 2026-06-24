# Vitest Failure Audit

Date: 2026-06-24

## Scope

Audit the current Vitest suite failures in this workspace, fixing only production/source-code regressions caused by recent changes and making no further edits to tests after the goal tweak. Existing modified/untracked test files are accepted workspace context.

## Accepted Test Working-Tree Context

The following test-file changes existed as accepted workspace context for this audit and were kept in place:

- M tests/unit/dashboard-guard.test.js
- ?? tests/translator/pipeline-source-format.test.js
- ?? tests/unit/compatible-retry-without-lock.test.js
- ?? tests/unit/import-provider-models.test.js
- ?? tests/unit/provider-models-import-capability.test.js

No additional test files, snapshots, assertions, or fixtures were edited after the goal tweak.

## Full Suite Result

Command:

```bash
cd tests && NODE_PATH=./node_modules ./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/9router-vitest-final.json --config ./vitest.config.js
```

Result retained in `VITEST_FULL_RESULT_SUMMARY.json` and `/tmp/9router-vitest-final.json`:

- Test suites: 347 total, 316 passed, 31 failed
- Tests: 1024 total, 938 passed, 34 failed, 52 pending
- Failed files: 15
- Success: false

## Count Reconciliation

The original prompt referred to 14 failed files/cases. Repeated current full-suite JSON runs now report 15 failed files and 34 failed tests. The extra/currently variable file is `tests/unit/mimo-free.live.test.js`, a live upstream test whose result changed during the session. The audit uses the current JSON truth: 15 failed files / 34 failed tests.

## Changed-Code Verification

Targeted changed-code command:

```bash
cd tests && NODE_PATH=./node_modules ./node_modules/.bin/vitest run --reporter=verbose --config ./vitest.config.js translator/pipeline-source-format.test.js unit/compatible-retry-without-lock.test.js unit/import-provider-models.test.js unit/provider-models-import-capability.test.js unit/dashboard-guard.test.js
```

Final observed result: exit code 0, 5 test files passed, 53 tests passed.

Production build command:

```bash
npm run build
```

Final observed result: exit code 0, successful Next production build.

## Per-Failing-File Classification

| Failing file | Failed tests/load errors | Classification | Evidence / rationale |
| --- | ---: | --- | --- |
| `tests/translator/golden-url-header.test.js` | 1 | Stale snapshot / environment drift | Cline header snapshot expects package/runtime values from 0.4.80 and Node v22, while current package/runtime produce 0.5.8 and Node v24. The test sanitizes credentials but not version/runtime headers. |
| `tests/unit/antigravity-mitm.test.js` | 1 | Pre-existing production/test mismatch outside recent changes | Already present in tests/__baseline__/baseline-results.json; Antigravity registry/MITM files have no current diff. |
| `tests/unit/claude-header-forwarding.test.js` | 1 | Pre-existing stale expectation | Already present in baseline; the current open-sse/utils/proxyFetch.js diff is only an import specifier change (`stream` to `node:stream`), while the got-scraping implementation remains intentionally commented out and unchanged. |
| `tests/unit/codex-image-fetch.test.js` | 2 | Unchanged-code mock incompatibility | Test mocks DNS lookup as a single object while hardened image fetch calls lookup(...,{all:true}) and expects an array; image/Codex runtime files have no current diff. |
| `tests/unit/combo-autoswitch.test.js` | 2 | Stale expectation against unchanged combo behavior | open-sse/services/combo.js says search auto-switch is temporarily disabled and returns a sorted copy for non-empty capability requirements; file has no current diff. |
| `tests/unit/db-benchmark.test.js` | 1 | Test harness/dependency issue | Suite imports lowdb, but npm ls lowdb --depth=0 reports no installed dependency; adding it solely for benchmark tests is out of scope. |
| `tests/unit/embeddings.cloud.test.js` | 1 | Test fixture/repo-shape issue | Suite imports ../../cloud/src/handlers/embeddings.js but no cloud directory exists in this checkout; already in baseline. |
| `tests/unit/executor-const-guard.test.js` | 1 | Pre-existing production/test mismatch outside recent changes | Test expects Antigravity 429 attempts=6, current registry has 3 and registry file has no current diff. This requires explicit product decision, not a recent-regression fix. |
| `tests/unit/image-fetch-hardening.test.js` | 1 | Unchanged-code mock incompatibility | Same DNS all-record mock mismatch as Codex image tests; image fetch source has no current diff. |
| `tests/unit/kiro-model-slots.test.js` | 1 | Pre-existing production/test mismatch outside recent changes | Already in baseline; Kiro registry/CLI/MITM files have no current diff. |
| `tests/unit/mimo-free.live.test.js` | 1 | Live upstream/environment drift | Live MiMo call has flipped between pass and fail during this session; latest failure is external HTTP behavior rather than deterministic local source evidence. |
| `tests/unit/oauth-cursor-auto-import.test.js` | 8 | Pre-existing stale expectation | Already in baseline; current route probes multiple locations and returns checked-location messages; route file has no current diff. |
| `tests/unit/openai-to-claude.test.js` | 1 | Pre-existing translator behavior mismatch | Already in baseline; relevant OpenAI-to-Claude response translator files have no current diff. |
| `tests/unit/rtk.test.js` | 10 | Pre-existing stale test/API mismatch | Already in baseline; open-sse/rtk/index.js exports compressMessages/formatRtkLog, not setRtkEnabled, and RTK files have no current diff. |
| `tests/unit/translator-request-normalization.test.js` | 4 | Pre-existing translator behavior mismatch | Already in baseline; request-format and stream-helper files have no current diff. |

## Individual Failing Test Inventory

### `tests/translator/golden-url-header.test.js`

- GOLDEN buildHeaders (default executor providers) cline → headers (apiKey / oauth): Error: Snapshot `GOLDEN buildHeaders (default executor providers) > cline → headers (apiKey / oauth) 1` mismatched

### `tests/unit/antigravity-mitm.test.js`

- Antigravity MITM model handling flags the out-of-box agent/Default model mandatory: AssertionError: expected undefined to be true // Object.is equality

### `tests/unit/claude-header-forwarding.test.js`

- proxyAwareFetch — api.anthropic.com routing routes api.anthropic.com to gotScraping (non-streaming) and returns ok response: AssertionError: expected "vi.fn()" to be called once, but got 0 times

### `tests/unit/codex-image-fetch.test.js`

- CodexExecutor image handling fetches 1MB remote image and inlines it as base64 data URI: AssertionError: expected false to be true // Object.is equality
- CodexExecutor image handling execute() prefetches images before sending to upstream: AssertionError: expected false to be true // Object.is equality

### `tests/unit/combo-autoswitch.test.js`

- detectRequiredCapabilities web_search tool -> search: AssertionError: expected false to be true // Object.is equality
- reorderByCapabilities keeps order when no model matches: AssertionError: expected [ 'deepseek/deepseek-chat', …(1) ] to be [ 'deepseek/deepseek-chat', …(1) ] // Object.is equality

### `tests/unit/db-benchmark.test.js`

- Suite load failure: Cannot find package 'lowdb' imported from /Users/iznogoud/Desktop/Projects-AI/Webplode/cpab-project/9router/tests/unit/db-benchmark.test.js

### `tests/unit/embeddings.cloud.test.js`

- Suite load failure: Cannot find module '/cloud/src/handlers/embeddings.js' imported from /Users/iznogoud/Desktop/Projects-AI/Webplode/cpab-project/9router/tests/unit/embeddings.cloud.test.js

### `tests/unit/executor-const-guard.test.js`

- antigravity retry (intentional change: 429=6, 503=3) 429 attempts = 6: AssertionError: expected 3 to be 6 // Object.is equality

### `tests/unit/image-fetch-hardening.test.js`

- fetchImageAsBase64 hardening accepts valid PNG from public host: AssertionError: expected null not to be null

### `tests/unit/kiro-model-slots.test.js`

- Kiro MITM model slots offers a mappable slot for the agent default model id 'auto': AssertionError: expected undefined to be truthy

### `tests/unit/mimo-free.live.test.js`

- MiMo Free anti-abuse gate (live) chat WITH Chrome User-Agent → 200: Error: STACK_TRACE_ERROR

### `tests/unit/oauth-cursor-auto-import.test.js`

- GET /api/oauth/cursor/auto-import returns not-found when no macOS cursor db paths are accessible: AssertionError: expected 'Cursor database not found. Checked lo…' to contain 'Cursor database not found in known ma…'
- GET /api/oauth/cursor/auto-import returns descriptive error if macOS db file exists but cannot be opened: AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string
- GET /api/oauth/cursor/auto-import extracts tokens using exact keys: AssertionError: expected false to be true // Object.is equality
- GET /api/oauth/cursor/auto-import unwraps JSON-encoded string values: AssertionError: expected false to be true // Object.is equality
- GET /api/oauth/cursor/auto-import falls back to fuzzy key matching on macOS when exact keys are missing: AssertionError: expected false to be true // Object.is equality
- GET /api/oauth/cursor/auto-import returns login-prompt error when tokens are missing even after fallback: AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string
- GET /api/oauth/cursor/auto-import linux uses single hardcoded path and original error message: AssertionError: expected 'Cursor database not found. Checked lo…' to be 'Cursor database not found. Make sure …' // Object.is equality
- GET /api/oauth/cursor/auto-import unsupported platform returns 400: AssertionError: expected 200 to be 400 // Object.is equality

### `tests/unit/openai-to-claude.test.js`

- openaiToClaudeResponse omits empty Read pages tool argument before emitting Claude input deltas: AssertionError: expected undefined to be defined

### `tests/unit/rtk.test.js`

- RTK flag default off, toggle works: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (disabled) returns null when disabled: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) compresses OpenAI tool message (string content): TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) compresses Claude string-form tool_result: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) compresses Claude array-form tool_result text parts: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) skips is_error tool_result: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) skips below MIN_COMPRESS_SIZE (<500 bytes): TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) never produces empty content (R14 guard): TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) skips when body has no messages: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function
- compressMessages (enabled) handles mix of messages without crashing: TypeError: (0 , __vite_ssr_import_1__.setRtkEnabled) is not a function

### `tests/unit/translator-request-normalization.test.js`

- request normalization claudeToOpenAIRequest flattens text-only content arrays into string: AssertionError: expected [ { type: 'text', text: 'hi' }, …(1) ] to be 'hi\nthere' // Object.is equality
- request normalization filterToOpenAIFormat flattens text-only arrays to string: AssertionError: expected [ { type: 'text', text: 'a' }, …(1) ] to be 'a\nb' // Object.is equality
- request normalization translateRequest keeps /v1/messages Claude->OpenAI text payloads string-safe: AssertionError: expected 'object' to be 'string' // Object.is equality
- request normalization parseSSELine supports provider raw NDJSON stream lines: AssertionError: expected null to deeply equal { model: 'gpt-oss:120b', …(2) }

## Source-Fix Decision

No current failed test was traced to a production/source regression caused by the recent changed files. Therefore no production/source compatibility hacks were applied to satisfy stale, harness, mock, environment, or live-upstream failures.

## Release Readiness

Docker `latest` was not built or pushed. If release policy requires full Vitest green, release remains blocked by the classified non-current-change failures. If release policy accepts those known failures, the changed-code slice and production build are green, but pushing still requires explicit user approval.
