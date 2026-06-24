# xAI Responses Executor — Progress Log

## 2026-06-23 — Completion audit and fixes ✅

### Research verified
- Read `open-sse/executors/base.js` for the BaseExecutor contract.
- Read `open-sse/executors/codex.js` for the closest Responses API executor shape.
- Read `open-sse/providers/registry/xai.js` for xAI `responsesUrl`, OAuth token URL, client ID, and existing `transport.baseUrl`.
- Read `open-sse/services/tokenRefresh/providers.js` and `open-sse/services/tokenRefresh.js` for `refreshXaiToken`, refresh retry, and lead scheduling conventions.
- Read `open-sse/handlers/chatCore.js`, `open-sse/translator/index.js`, and `open-sse/translator/formats.js` for executor and translator integration.
- Read `open-sse/translator/formats/claude.js` and `open-sse/translator/formats/responsesApi.js` for Claude/Responses normalization concerns.
- Read `CLIProxyAPI/internal/runtime/executor/xai_executor.go`, `CLIProxyAPI/internal/auth/xai/xai.go`, and `CLIProxyAPI/internal/auth/xai/types.go` as the authoritative behavior reference.

### Implementation verified
- Created `open-sse/executors/xai-responses/executor.js` extending `BaseExecutor` without changing BaseExecutor signatures.
- Registered `XaiResponsesExecutor` in `open-sse/executors/index.js` under provider key `xai`.
- Updated `open-sse/providers/registry/xai.js` transport with `format: "openai-responses"` and `forceStream: true` while preserving `transport.baseUrl` unchanged.
- Added `open-sse/executors/xai-responses/executor.test.js` with 65 cold-startable unit tests and no live network calls.
- Updated `open-sse/transformer/streamToJsonConverter.js` so `response.completed` output is extracted even when `response.output_item.done` is absent.

### CPA Go behavior mirrored
1. Tool normalization: `custom`→`function`, namespace flattening, strip `tool_search`/`image_generation`, strip custom `apply_patch`, strip `web_search.external_web_access`, ensure function `parameters`, drop `tool_choice`/`parallel_tool_calls` when no tools remain.
2. Credential injection: `Authorization: Bearer ...` from `accessToken`, `providerSpecificData.access_token`, or `apiKey`; no Authorization when no token exists.
3. URL construction: default `https://api.x.ai/v1/responses`, same endpoint for streaming and non-streaming, custom `providerSpecificData.baseUrl/base_url` without double slash.
4. Session ID: `prompt_cache_key` then `connectionId`, injected as `x-grok-conv-id` when present.
5. OAuth refresh: 5-minute lead in `needsRefresh`; `refreshCredentials` delegates to `refreshXaiToken` and writes back access token, refresh token, and expiry.
6. Body sanitization: strip unsupported fields, remove `reasoning.encrypted_content` include, sanitize null reasoning item `content` and `encrypted_content`.
7. Responses SSE handling: streaming chunks are preserved; non-streaming conversion extracts `response.completed` output and usage.

### Test coverage
- Tool normalization: custom→function, namespace flattening, hosted tool stripping, web search cleanup, parameters injection, `apply_patch` stripping, tool-choice cleanup.
- Credential injection: Bearer header, access-token fallbacks, no-token case, streaming/non-streaming Accept headers, Keep-Alive, `x-grok-conv-id` injection/omission.
- URL construction: default endpoint, streaming/non-streaming parity, registry `responsesUrl`, custom base URL/base_url, double-slash avoidance.
- Refresh scheduling: within/outside 5-minute lead, expired credentials, `tokenExpiresAt` fallback, missing expiry, null credentials, no refresh token.
- Body/request handling: unsupported field stripping, include filtering, reasoning sanitization, session resolution, caller body immutability.
- Integration contract: xAI provider advertises `openai-responses`, `forceStream: true`, preserved chat `baseUrl`, and `responsesUrl`.
- Response/error behavior: `response.completed` extraction, `output_item.done` assembly, SSE event/data preservation, non-200 response path, JSON/text/empty error parsing.

### Final proof
- `node --test open-sse/executors/xai-responses/*.test.js`
- Result: 65 tests, 11 suites, 65 pass, 0 fail.
- Only warning: Node reports `MODULE_TYPELESS_PACKAGE_JSON` because the repository package is not marked `type: "module"`; tests still pass.
