import { describe, expect, it } from "vitest";
import { prepareResponsesBodyForChatCore } from "../../open-sse/handlers/responsesHandler.js";

describe("Responses handler dispatch for OpenAI-compatible nodes", () => {
  it("preserves Responses shape and strips Chat token aliases for /responses nodes", () => {
    const out = prepareResponsesBodyForChatCore(
      { model: "gpt-5.5", input: "hello", max_tokens: 123 },
      { provider: "openai-compatible-responses-test" }
    );

    expect(out.input).toBe("hello");
    expect(out.messages).toBeUndefined();
    expect(out.max_output_tokens).toBe(123);
    expect(out.max_tokens).toBeUndefined();
    expect(out.stream).toBe(false);
  });

  it("converts Responses input to Chat shape for chat-compatible nodes", () => {
    const out = prepareResponsesBodyForChatCore(
      { model: "gpt-5.5", input: "hello", max_output_tokens: 456 },
      { provider: "openai-compatible-chat-test" }
    );

    expect(out.input).toBeUndefined();
    expect(out.messages?.[0]?.role).toBe("user");
    expect(out.messages?.[0]?.content?.[0]?.text).toBe("hello");
    expect(out.max_tokens).toBe(456);
    expect(out.max_output_tokens).toBeUndefined();
    expect(out.stream).toBe(false);
  });
});
