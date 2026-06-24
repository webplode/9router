import { describe, it, expect } from "vitest";
import { resolveSourceFormat } from "../../open-sse/handlers/pipeline.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("resolveSourceFormat (endpoint-first pipeline)", () => {
  it("/v1/messages → claude", () => {
    expect(
      resolveSourceFormat({
        pathname: "/api/v1/messages",
        body: { model: "claude/opus", messages: [{ role: "user", content: "hi" }] },
      })
    ).toBe(FORMATS.CLAUDE);
  });

  it("/v1/responses → openai-responses", () => {
    expect(
      resolveSourceFormat({
        pathname: "/v1/responses",
        body: { model: "openai/gpt-4", input: "hello" },
      })
    ).toBe(FORMATS.OPENAI_RESPONSES);
  });

  it("/v1/chat/completions + messages → openai (body fallback)", () => {
    expect(
      resolveSourceFormat({
        pathname: "/v1/chat/completions",
        body: { model: "x", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } },
      })
    ).toBe(FORMATS.OPENAI);
  });

  it("body with input only → openai-responses when no endpoint override", () => {
    expect(
      resolveSourceFormat({
        pathname: null,
        body: { model: "x", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a" }] }] },
      })
    ).toBe(FORMATS.OPENAI_RESPONSES);
  });
});