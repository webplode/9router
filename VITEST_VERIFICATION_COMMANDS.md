# Vitest Audit Verification Commands

Date: 2026-06-24

## Full Vitest Suite

Command:

```bash
cd tests && NODE_PATH=./node_modules ./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/9router-vitest-final.json --config ./vitest.config.js
```

Observed result from `VITEST_FULL_RESULT_SUMMARY.json` / `/tmp/9router-vitest-final.json`:

- 347 suites total
- 316 suites passed
- 31 suites failed
- 1024 tests total
- 938 tests passed
- 34 tests failed
- 52 tests pending
- 15 failed files

## Targeted Changed-Code Slice

Command:

```bash
cd tests && NODE_PATH=./node_modules ./node_modules/.bin/vitest run --reporter=verbose --config ./vitest.config.js translator/pipeline-source-format.test.js unit/compatible-retry-without-lock.test.js unit/import-provider-models.test.js unit/provider-models-import-capability.test.js unit/dashboard-guard.test.js
```

Observed result from final rerun:

- Exit code: 0
- Test files: 5 passed
- Tests: 53 passed

## Production Build

Command:

```bash
npm run build
```

Observed result from final rerun:

- Exit code: 0
- Next production build completed successfully
- TypeScript phase completed
- Route generation completed
