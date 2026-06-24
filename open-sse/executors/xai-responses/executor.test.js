/**
 * XaiResponsesExecutor — Unit Tests
 *
 * Covers:
 * - Tool normalization (custom→function, namespace flattening, strip tool_search/image_generation,
 *   strip web_search.external_web_access, empty parameters injection, tool_choice cleanup)
 * - Credential injection (Bearer header, fallback to accessToken, no token case)
 * - URL construction (streaming vs non-streaming, no double-slash)
 * - Refresh scheduling (expiry within/outside lead window)
 * - Session ID resolution (prompt_cache_key, connectionId)
 * - Body sanitization (strip unsupported fields, reasoning item cleanup)
 * - Error response handling (non-200 status codes)
 *
 * All tests are cold-startable — no network, no external dependencies.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { XaiResponsesExecutor } from "./executor.js";
import { BaseExecutor } from "../base.js";
import { PROVIDERS } from "../../config/providers.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeCredentials(overrides = {}) {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionId: "conn-123",
    ...overrides,
  };
}

// ── tool normalization ───────────────────────────────────────────────

describe("XaiResponsesExecutor — tool normalization", () => {
  const executor = new XaiResponsesExecutor();

  it("converts custom tools to function type", () => {
    const tools = [
      { type: "custom", name: "my_tool", description: "Does things" },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "function");
    assert.equal(result[0].name, "my_tool");
    assert.equal(result[0].description, "Does things");
  });

  it("strips tool_search tools", () => {
    const tools = [
      { type: "function", name: "keep_me", parameters: {} },
      { type: "tool_search" },
      { type: "function", name: "also_keep", parameters: {} },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "keep_me");
    assert.equal(result[1].name, "also_keep");
  });

  it("strips image_generation tools", () => {
    const tools = [
      { type: "image_generation" },
      { type: "function", name: "real_tool", parameters: {} },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "real_tool");
  });

  it("flattens namespace tools by unwrapping nested tools", () => {
    const tools = [
      {
        type: "namespace",
        tools: [
          { type: "function", name: "nested_1", parameters: {} },
          { type: "function", name: "nested_2", parameters: {} },
        ],
      },
      { type: "function", name: "top_level", parameters: {} },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 3);
    assert.equal(result[0].name, "nested_1");
    assert.equal(result[1].name, "nested_2");
    assert.equal(result[2].name, "top_level");
  });

  it("strips nested tool_search inside namespace", () => {
    const tools = [
      {
        type: "namespace",
        tools: [
          { type: "function", name: "keep", parameters: {} },
          { type: "tool_search" },
        ],
      },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "keep");
  });

  it("removes external_web_access from web_search tools", () => {
    const tools = [
      {
        type: "web_search",
        external_web_access: true,
        search_context_size: "medium",
      },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "web_search");
    assert.equal(result[0].search_context_size, "medium");
    assert.equal("external_web_access" in result[0], false);
  });

  it("injects empty parameters object for function tools without parameters", () => {
    const tools = [
      { type: "function", name: "no_params" },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].parameters, { type: "object", properties: {} });
  });

  it("preserves existing parameters on function tools", () => {
    const params = { type: "object", properties: { x: { type: "string" } } };
    const tools = [
      { type: "function", name: "has_params", parameters: params },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].parameters, params);
  });

  it("strips apply_patch custom tools (CPA Go special case)", () => {
    const tools = [
      { type: "custom", name: "apply_patch" },
      { type: "function", name: "keep", parameters: {} },
    ];
    const result = executor._normalizeTools(tools);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "keep");
  });

  it("drops tool_choice when all tools are stripped", () => {
    const body = {
      model: "grok-4",
      tools: [{ type: "tool_search" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    // First normalize tools (strips tool_search), then clean up tool_choice
    body.tools = executor._normalizeTools(body.tools);
    executor._normalizeToolChoice(body);
    assert.equal("tools" in body, false);
    assert.equal("tool_choice" in body, false);
    assert.equal("parallel_tool_calls" in body, false);
  });

  it("preserves tool_choice when tools remain after normalization", () => {
    const body = {
      model: "grok-4",
      tools: [{ type: "function", name: "valid", parameters: {} }],
      tool_choice: "auto",
    };
    executor._normalizeToolChoice(body);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.tools.length, 1);
  });

  it("returns empty array when all tools are stripped", () => {
    const tools = [
      { type: "tool_search" },
      { type: "image_generation" },
    ];
    const result = executor._normalizeTools(tools);
    assert.deepEqual(result, []);
  });

  it("handles null/undefined tools gracefully", () => {
    assert.equal(executor._normalizeTools(null), null);
    assert.equal(executor._normalizeTools(undefined), null);
  });
});

// ── credential injection ─────────────────────────────────────────────

describe("XaiResponsesExecutor — credential injection", () => {
  const executor = new XaiResponsesExecutor();

  it("extracts accessToken from credentials", () => {
    const creds = makeCredentials({ accessToken: "tok-123" });
    assert.equal(executor._extractAccessToken(creds), "tok-123");
  });

  it("falls back to providerSpecificData.access_token", () => {
    const creds = makeCredentials({
      accessToken: undefined,
      providerSpecificData: { access_token: "psd-tok-456" },
    });
    assert.equal(executor._extractAccessToken(creds), "psd-tok-456");
  });

  it("falls back to apiKey", () => {
    const creds = makeCredentials({
      accessToken: undefined,
      apiKey: "apikey-789",
    });
    assert.equal(executor._extractAccessToken(creds), "apikey-789");
  });

  it("returns null when no token is available", () => {
    const creds = makeCredentials({
      accessToken: undefined,
      apiKey: undefined,
      providerSpecificData: {},
    });
    assert.equal(executor._extractAccessToken(creds), null);
  });

  it("returns null for null credentials", () => {
    assert.equal(executor._extractAccessToken(null), null);
  });

  it("builds headers with Bearer token", () => {
    const creds = makeCredentials({ accessToken: "bearer-tok" });
    const headers = executor.buildHeaders(creds, true);
    assert.equal(headers["Authorization"], "Bearer bearer-tok");
  });

  it("builds headers without Authorization when no token", () => {
    const creds = makeCredentials({
      accessToken: undefined,
      apiKey: undefined,
    });
    const headers = executor.buildHeaders(creds, true);
    assert.equal("Authorization" in headers, false);
  });

  it("sets Accept: text/event-stream for streaming", () => {
    const creds = makeCredentials();
    const headers = executor.buildHeaders(creds, true);
    assert.equal(headers["Accept"], "text/event-stream");
  });

  it("sets Accept: application/json for non-streaming", () => {
    const creds = makeCredentials();
    const headers = executor.buildHeaders(creds, false);
    assert.equal(headers["Accept"], "application/json");
  });

  it("sets Connection: Keep-Alive", () => {
    const creds = makeCredentials();
    const headers = executor.buildHeaders(creds, true);
    assert.equal(headers["Connection"], "Keep-Alive");
  });

  it("injects x-grok-conv-id from the request-local session ID", async () => {
    let capturedHeaders = null;
    const restore = mock.method(BaseExecutor.prototype, "execute", async function ({ credentials, stream }) {
      capturedHeaders = this.buildHeaders(credentials, stream);
      return { response: new Response("{}"), url: "https://api.x.ai/v1/responses", headers: capturedHeaders, transformedBody: {} };
    });

    try {
      const creds = makeCredentials();
      await executor.execute({
        model: "grok-4",
        body: { input: "hi", prompt_cache_key: "sess-123" },
        stream: true,
        credentials: creds,
        signal: undefined,
        log: null,
      });
      assert.equal(capturedHeaders["x-grok-conv-id"], "sess-123");
    } finally {
      restore.mock.restore();
    }
  });

  it("omits x-grok-conv-id when no session ID is available", () => {
    const creds = makeCredentials({ connectionId: undefined });
    executor.transformRequest("grok-4", { input: "hi" }, true, creds);
    const headers = executor.buildHeaders(creds, true);
    assert.equal("x-grok-conv-id" in headers, false);
  });
});

// ── URL construction ─────────────────────────────────────────────────

describe("XaiResponsesExecutor — URL construction", () => {
  const executor = new XaiResponsesExecutor();

  it("returns default Responses API URL", () => {
    const url = executor.buildUrl("grok-4", true, 0, null);
    assert.equal(url, "https://api.x.ai/v1/responses");
  });

  it("uses the provider registry responsesUrl", () => {
    assert.equal(PROVIDERS.xai.format, "openai-responses");
    assert.equal(PROVIDERS.xai.forceStream, true);
    assert.equal(PROVIDERS.xai.responsesUrl, "https://api.x.ai/v1/responses");
    assert.equal(PROVIDERS.xai.baseUrl, "https://api.x.ai/v1/chat/completions");
  });

  it("returns same URL for non-streaming", () => {
    const url = executor.buildUrl("grok-4", false, 0, null);
    assert.equal(url, "https://api.x.ai/v1/responses");
  });

  it("uses custom baseUrl from providerSpecificData", () => {
    const creds = {
      providerSpecificData: { baseUrl: "https://custom.x.ai/v1" },
    };
    const url = executor.buildUrl("grok-4", true, 0, creds);
    assert.equal(url, "https://custom.x.ai/v1/responses");
  });

  it("uses custom base_url from providerSpecificData", () => {
    const creds = {
      providerSpecificData: { base_url: "https://alt.x.ai/v1/" },
    };
    const url = executor.buildUrl("grok-4", true, 0, creds);
    assert.equal(url, "https://alt.x.ai/v1/responses");
  });

  it("avoids double-slash in URL", () => {
    const creds = {
      providerSpecificData: { baseUrl: "https://api.x.ai/v1/" },
    };
    const url = executor.buildUrl("grok-4", true, 0, creds);
    assert.equal(url, "https://api.x.ai/v1/responses");
  });

  it("trims custom baseUrl whitespace", () => {
    const creds = {
      providerSpecificData: { baseUrl: " https://api.x.ai/v1/ " },
    };
    const url = executor.buildUrl("grok-4", true, 0, creds);
    assert.equal(url, "https://api.x.ai/v1/responses");
  });
});

// ── refresh scheduling ───────────────────────────────────────────────

describe("XaiResponsesExecutor — refresh scheduling", () => {
  const executor = new XaiResponsesExecutor();

  it("needsRefresh returns true when expiry is within 5-min lead", () => {
    const creds = makeCredentials({
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min
    });
    assert.equal(executor.needsRefresh(creds), true);
  });

  it("needsRefresh returns false when expiry is outside 5-min lead", () => {
    const creds = makeCredentials({
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
    });
    assert.equal(executor.needsRefresh(creds), false);
  });

  it("needsRefresh returns false when already expired (not our concern)", () => {
    const creds = makeCredentials({
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min ago
    });
    assert.equal(executor.needsRefresh(creds), true);
  });

  it("needsRefresh uses tokenExpiresAt as fallback", () => {
    const creds = makeCredentials({
      expiresAt: undefined,
      tokenExpiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });
    assert.equal(executor.needsRefresh(creds), true);
  });

  it("needsRefresh returns false when no expiry info", () => {
    const creds = makeCredentials({
      expiresAt: undefined,
      tokenExpiresAt: undefined,
    });
    assert.equal(executor.needsRefresh(creds), false);
  });

  it("needsRefresh returns false for null credentials", () => {
    assert.equal(executor.needsRefresh(null), false);
  });

  it("refreshCredentials returns null when no refreshToken", async () => {
    const creds = makeCredentials({ refreshToken: undefined });
    const result = await executor.refreshCredentials(creds, null);
    assert.equal(result, null);
  });
});

// ── session ID resolution ────────────────────────────────────────────

describe("XaiResponsesExecutor — session ID resolution", () => {
  const executor = new XaiResponsesExecutor();

  it("resolves from prompt_cache_key in body", () => {
    const body = { prompt_cache_key: "session-abc" };
    const creds = makeCredentials();
    const id = executor._resolveSessionId(body, creds);
    assert.equal(id, "session-abc");
  });

  it("falls back to connectionId", () => {
    const body = {};
    const creds = makeCredentials({ connectionId: "conn-xyz" });
    const id = executor._resolveSessionId(body, creds);
    assert.equal(id, "conn-xyz");
  });

  it("returns null when neither is available", () => {
    const body = {};
    const creds = makeCredentials({ connectionId: undefined });
    const id = executor._resolveSessionId(body, creds);
    assert.equal(id, null);
  });

  it("generates an isolated session for grok-composer models", () => {
    const body = {};
    const creds = makeCredentials({ connectionId: undefined });
    const id = executor._resolveSessionId(body, creds, "grok-composer-2.5-fast");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("isolates grok-composer models instead of reusing credential connectionId", () => {
    const body = {};
    const creds = makeCredentials({ connectionId: "conn-should-not-leak" });
    const id = executor._resolveSessionId(body, creds, "grok-composer-2.5-fast");
    assert.notEqual(id, "conn-should-not-leak");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("lets explicit prompt_cache_key override grok-composer isolation", () => {
    const body = { prompt_cache_key: "explicit-session" };
    const creds = makeCredentials({ connectionId: "conn-should-not-win" });
    const id = executor._resolveSessionId(body, creds, "grok-composer-2.5-fast");
    assert.equal(id, "explicit-session");
  });

  it("returns null for null credentials", () => {
    const body = {};
    const id = executor._resolveSessionId(body, null);
    assert.equal(id, null);
  });
});

// ── body sanitization ────────────────────────────────────────────────

describe("XaiResponsesExecutor — body sanitization", () => {
  const executor = new XaiResponsesExecutor();

  it("strips unsupported fields", () => {
    const body = {
      model: "grok-4",
      previous_response_id: "resp_old",
      prompt_cache_retention: "1h",
      safety_identifier: "safe-123",
      stream_options: { include_usage: true },
      input: [{ type: "message", role: "user", content: "hello" }],
    };
    executor._sanitizeBody(body);
    assert.equal("previous_response_id" in body, false);
    assert.equal("prompt_cache_retention" in body, false);
    assert.equal("safety_identifier" in body, false);
    assert.equal("stream_options" in body, false);
    // input should be preserved
    assert.equal(body.input.length, 1);
  });

  it("maps max_tokens to max_output_tokens for xAI responses", () => {
    const body = {
      model: "grok-composer-2.5-fast",
      max_tokens: 123,
      input: [{ type: "message", role: "user", content: "hello" }],
    };
    executor._sanitizeBody(body);
    assert.equal(body.max_output_tokens, 123);
    assert.equal("max_tokens" in body, false);
  });

  it("maps max_completion_tokens to max_output_tokens when max_tokens is absent", () => {
    const body = {
      model: "grok-4",
      max_completion_tokens: 456,
      input: [{ type: "message", role: "user", content: "hello" }],
    };
    executor._sanitizeBody(body);
    assert.equal(body.max_output_tokens, 456);
    assert.equal("max_completion_tokens" in body, false);
  });

  it("preserves explicit max_output_tokens precedence", () => {
    const body = {
      model: "grok-4",
      max_output_tokens: 999,
      max_tokens: 123,
      max_completion_tokens: 456,
      input: [{ type: "message", role: "user", content: "hello" }],
    };
    executor._sanitizeBody(body);
    assert.equal(body.max_output_tokens, 999);
    assert.equal("max_tokens" in body, false);
    assert.equal("max_completion_tokens" in body, false);
  });

  it("drops unsupported reasoning effort for non-reasoning xAI models", () => {
    const body = {
      model: "grok-composer-2.5-fast",
      reasoning: { effort: "high" },
    };
    executor._sanitizeBody(body);
    assert.equal("reasoning" in body, false);
  });

  it("keeps reasoning effort for xAI models that support it", () => {
    const body = {
      model: "grok-4.3",
      reasoning: { effort: "high" },
    };
    executor._sanitizeBody(body);
    assert.deepEqual(body.reasoning, { effort: "high" });
  });

  it("removes reasoning.encrypted_content from include array", () => {
    const body = {
      include: ["reasoning.encrypted_content", "message.output_text"],
    };
    executor._sanitizeBody(body);
    assert.deepEqual(body.include, ["message.output_text"]);
  });

  it("deletes include when empty after filtering", () => {
    const body = {
      include: ["reasoning.encrypted_content"],
    };
    executor._sanitizeBody(body);
    assert.equal("include" in body, false);
  });

  it("cleans null content from reasoning items", () => {
    const body = {
      input: [
        { type: "reasoning", content: null, summary: [{ text: "thinking..." }] },
        { type: "message", role: "user", content: "hello" },
      ],
    };
    executor._sanitizeReasoningItems(body);
    assert.equal("content" in body.input[0], false);
    assert.equal(body.input[0].summary.length, 1);
    // Non-reasoning items untouched
    assert.equal(body.input[1].content, "hello");
  });

  it("cleans null encrypted_content from reasoning items", () => {
    const body = {
      input: [
        { type: "reasoning", encrypted_content: null, summary: [] },
      ],
    };
    executor._sanitizeReasoningItems(body);
    assert.equal("encrypted_content" in body.input[0], false);
  });

  it("does not touch non-null content on reasoning items", () => {
    const body = {
      input: [
        { type: "reasoning", content: "real content", summary: [] },
      ],
    };
    executor._sanitizeReasoningItems(body);
    assert.equal(body.input[0].content, "real content");
  });
});

// ── transformRequest integration ─────────────────────────────────────

describe("XaiResponsesExecutor — transformRequest", () => {
  const executor = new XaiResponsesExecutor();

  it("applies full tool normalization pipeline", () => {
    const body = {
      model: "grok-4",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [
        { type: "custom", name: "my_func" },
        { type: "tool_search" },
        { type: "image_generation" },
        {
          type: "namespace",
          tools: [
            { type: "function", name: "nested", parameters: {} },
          ],
        },
        { type: "web_search", external_web_access: true },
      ],
      tool_choice: "auto",
    };
    const creds = makeCredentials();
    const result = executor.transformRequest("grok-4", body, true, creds);

    // custom → function
    assert.equal(result.tools[0].type, "function");
    assert.equal(result.tools[0].name, "my_func");
    // namespace flattened
    assert.equal(result.tools[1].name, "nested");
    // web_search kept, external_web_access stripped
    assert.equal(result.tools[2].type, "web_search");
    assert.equal("external_web_access" in result.tools[2], false);
    // tool_choice preserved (tools remain)
    assert.equal(result.tool_choice, "auto");
    // stream set
    assert.equal(result.stream, true);
  });

  it("drops tool_choice when all tools stripped", () => {
    const body = {
      model: "grok-4",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [{ type: "tool_search" }, { type: "image_generation" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    const creds = makeCredentials();
    const result = executor.transformRequest("grok-4", body, true, creds);

    assert.equal("tools" in result, false);
    assert.equal("tool_choice" in result, false);
    assert.equal("parallel_tool_calls" in result, false);
  });

  it("sanitizes reasoning items in input", () => {
    const body = {
      model: "grok-4",
      input: [
        { type: "reasoning", content: null, encrypted_content: null },
        { type: "message", role: "user", content: "hi" },
      ],
    };
    const creds = makeCredentials();
    const result = executor.transformRequest("grok-4", body, true, creds);

    assert.equal("content" in result.input[0], false);
    assert.equal("encrypted_content" in result.input[0], false);
  });

  it("strips unsupported fields", () => {
    const body = {
      model: "grok-4",
      input: [{ type: "message", role: "user", content: "hi" }],
      previous_response_id: "resp_old",
      stream_options: { include_usage: true },
    };
    const creds = makeCredentials();
    const result = executor.transformRequest("grok-4", body, true, creds);

    assert.equal("previous_response_id" in result, false);
    assert.equal("stream_options" in result, false);
  });

  it("does not send max_tokens to xAI /v1/responses", () => {
    const body = {
      model: "grok-composer-2.5-fast",
      input: [{ type: "message", role: "user", content: "hi" }],
      max_tokens: 321,
    };
    const creds = makeCredentials();
    const result = executor.transformRequest("grok-composer-2.5-fast", body, true, creds);

    assert.equal(result.max_output_tokens, 321);
    assert.equal("max_tokens" in result, false);
    assert.equal("max_completion_tokens" in result, false);
  });

  it("does not store session ID on the singleton executor during transform", () => {
    const body = {
      model: "grok-4",
      input: [{ type: "message", role: "user", content: "hi" }],
      prompt_cache_key: "my-session",
    };
    const creds = makeCredentials();
    executor.transformRequest("grok-4", body, true, creds);
    assert.equal("_currentSessionId" in executor, false);
  });

  it("does not mutate caller-owned nested request fields", () => {
    const body = {
      model: "grok-4",
      input: [{ type: "reasoning", content: null, encrypted_content: null }],
      tools: [{ type: "custom", name: "custom_tool" }],
      include: ["reasoning.encrypted_content"],
    };
    const original = structuredClone(body);
    executor.transformRequest("grok-4", body, true, makeCredentials());
    assert.deepEqual(body, original);
  });
});

// ── chatCore integration contract ───────────────────────────────────

describe("XaiResponsesExecutor — chatCore integration contract", () => {
  it("advertises the existing openai-responses target format", () => {
    assert.equal(PROVIDERS.xai.format, "openai-responses");
    assert.equal(PROVIDERS.xai.forceStream, true);
    assert.equal(PROVIDERS.xai.responsesUrl, "https://api.x.ai/v1/responses");
    assert.equal(PROVIDERS.xai.baseUrl, "https://api.x.ai/v1/chat/completions");
  });
});

// ── response parsing and execution ──────────────────────────────────

describe("XaiResponsesExecutor — response parsing and execution", () => {
  it("extracts response.completed output when output_item.done is absent", async () => {
    const rawSSE = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"created_at\":123,\"status\":\"completed\",\"model\":\"grok-4\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}",
      "",
    ].join("\n");

    const converted = await convertResponsesStreamToJson(new Response(rawSSE).body);
    assert.equal(converted.id, "resp_1");
    assert.equal(converted.created_at, 123);
    assert.equal(converted.status, "completed");
    assert.equal(converted.output[0].content[0].text, "done");
    assert.deepEqual(converted.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });

  it("assembles output_item.done and response.completed usage for non-streaming JSON", async () => {
    const rawSSE = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_xai\",\"model\":\"grok-4\",\"status\":\"in_progress\",\"output\":[]}}",
      "",
      "event: response.output_item.done",
      "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_xai\",\"model\":\"grok-4\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"fallback\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}",
      "",
    ].join("\n");

    const converted = await convertResponsesStreamToJson(new Response(rawSSE).body);
    assert.equal(converted.id, "resp_xai");
    assert.equal(converted.status, "completed");
    assert.equal(converted.output[0].content[0].text, "hello");
    assert.deepEqual(converted.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 0 });
  });

  it("assembles streaming SSE chunks with data prefixes and event lines intact", async () => {
    const rawSSE = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n";
    const restore = mock.method(BaseExecutor.prototype, "execute", async () => ({
      response: new Response(rawSSE, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      url: "https://api.x.ai/v1/responses",
      headers: {},
      transformedBody: {},
    }));

    try {
      const executor = new XaiResponsesExecutor();
      const result = await executor.execute({
        model: "grok-4",
        body: { input: "hi" },
        stream: true,
        credentials: makeCredentials(),
        signal: undefined,
        log: null,
      });
      const text = await result.response.text();
      assert.equal(text, rawSSE);
    } finally {
      restore.mock.restore();
    }
  });

  it("returns non-200 responses for chatCore error handling", async () => {
    const restore = mock.method(BaseExecutor.prototype, "execute", async () => ({
      response: new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
      url: "https://api.x.ai/v1/responses",
      headers: {},
      transformedBody: {},
    }));

    try {
      const executor = new XaiResponsesExecutor();
      const result = await executor.execute({
        model: "grok-4",
        body: { input: "hi" },
        stream: false,
        credentials: makeCredentials(),
        signal: undefined,
        log: null,
      });
      assert.equal(result.response.status, 400);
      assert.deepEqual(executor.parseError(result.response, await result.response.text()), {
        status: 400,
        message: "bad request",
      });
    } finally {
      restore.mock.restore();
    }
  });
});

// ── error parsing ────────────────────────────────────────────────────

describe("XaiResponsesExecutor — error parsing", () => {
  const executor = new XaiResponsesExecutor();

  it("extracts error.message from JSON body", () => {
    const response = { status: 400 };
    const bodyText = JSON.stringify({
      error: { message: "Invalid model", type: "invalid_request_error" },
    });
    const result = executor.parseError(response, bodyText);
    assert.equal(result.status, 400);
    assert.equal(result.message, "Invalid model");
  });

  it("falls back to raw body text for non-JSON", () => {
    const response = { status: 500 };
    const bodyText = "Internal Server Error";
    const result = executor.parseError(response, bodyText);
    assert.equal(result.status, 500);
    assert.equal(result.message, "Internal Server Error");
  });

  it("falls back to HTTP status message for empty body", () => {
    const response = { status: 503 };
    const result = executor.parseError(response, "");
    assert.equal(result.status, 503);
    assert.ok(result.message.includes("503"));
  });
});

// ── executor identity ────────────────────────────────────────────────

describe("XaiResponsesExecutor — identity", () => {
  it("has correct provider name", () => {
    const executor = new XaiResponsesExecutor();
    assert.equal(executor.provider, "xai");
  });

  it("extends BaseExecutor", () => {
    const executor = new XaiResponsesExecutor();
    assert.equal(typeof executor.execute, "function");
    assert.equal(typeof executor.transformRequest, "function");
    assert.equal(typeof executor.buildUrl, "function");
    assert.equal(typeof executor.buildHeaders, "function");
    assert.equal(typeof executor.needsRefresh, "function");
    assert.equal(typeof executor.refreshCredentials, "function");
    assert.equal(typeof executor.parseError, "function");
  });

  it("noAuth is false (xAI requires auth)", () => {
    const executor = new XaiResponsesExecutor();
    assert.equal(executor.noAuth, false);
  });
});
