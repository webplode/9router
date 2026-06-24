import { describe, it, expect } from "vitest";
import {
  deriveOpenAIModelsListUrl,
  resolveRegistryOpenAIModelsUrl,
  providerSupportsRegistryOpenAIFallback,
  connectionSupportsModelsImport,
  formatModelsImportHttpError,
  providerIsImportableRegistryId,
  isRegistryLlmProvider,
  getRegistryEntry,
} from "../../open-sse/services/providerModelsImport.js";
import {
  providerIdSupportsModelsImport,
  getImportModelsUiState,
} from "../../src/shared/utils/providerModelsImportCapability.js";

describe("deriveOpenAIModelsListUrl", () => {
  it("maps chat/completions to /models", () => {
    expect(deriveOpenAIModelsListUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("returns null for /messages anthropic base", () => {
    expect(deriveOpenAIModelsListUrl("https://api.z.ai/api/anthropic/v1/messages")).toBeNull();
  });
});

describe("resolveRegistryOpenAIModelsUrl", () => {
  it("uses validateUrl when set", () => {
    expect(resolveRegistryOpenAIModelsUrl("deepseek")).toBe("https://api.deepseek.com/models");
  });

  it("uses openai transport for glm not primary anthropic transport", () => {
    expect(resolveRegistryOpenAIModelsUrl("glm")).toBe(
      "https://api.z.ai/api/coding/paas/v4/models"
    );
  });
});

describe("formatModelsImportHttpError", () => {
  it("includes code and status", () => {
    expect(formatModelsImportHttpError(401).code).toBe("upstream_error");
    expect(formatModelsImportHttpError(401).status).toBe(401);
  });
});

describe("providerSupportsRegistryOpenAIFallback", () => {
  it("false when already in explicit list", () => {
    expect(providerSupportsRegistryOpenAIFallback("openai")).toBe(false);
  });
});

describe("providerIdSupportsModelsImport", () => {
  it("true for openai-compatible node id", () => {
    expect(providerIdSupportsModelsImport("openai-compatible-chat-abc")).toBe(true);
  });

  it("true for explicit openai", () => {
    expect(providerIdSupportsModelsImport("openai")).toBe(true);
  });

  it("true for oauth iflow (registry LLM)", () => {
    expect(providerIdSupportsModelsImport("iflow")).toBe(true);
  });

  it("true for oauth cline", () => {
    expect(providerIdSupportsModelsImport("cline")).toBe(true);
  });
});

describe("resolveRegistryOpenAIModelsUrl oauth", () => {
  it("iflow chat/completions → models", () => {
    expect(resolveRegistryOpenAIModelsUrl("iflow")).toBe("https://apis.iflow.cn/v1/models");
  });
});

describe("isRegistryLlmProvider", () => {
  it("false for tts-only edge-tts", () => {
    const entry = getRegistryEntry("edge-tts");
    expect(isRegistryLlmProvider(entry)).toBe(false);
  });

  it("true for iflow", () => {
    expect(isRegistryLlmProvider(getRegistryEntry("iflow"))).toBe(true);
  });
});

describe("providerIsKnownRegistryId", () => {
  it("true for media-only elevenlabs", () => {
    expect(providerIdSupportsModelsImport("elevenlabs")).toBe(true);
  });
});

describe("buildOpenAIFallbackModelsConfig auth", () => {
  it("glm openai transport uses Authorization Bearer", async () => {
    const { buildOpenAIFallbackModelsConfig } = await import("../../open-sse/services/providerModelsImport.js");
    const cfg = buildOpenAIFallbackModelsConfig("https://api.z.ai/api/coding/paas/v4/models", "glm");
    expect(cfg.authHeader).toBe("Authorization");
    expect(cfg.authPrefix).toBe("Bearer ");
  });

  it("cline oauth uses Bearer and cline headers", async () => {
    const { buildOpenAIFallbackModelsConfig } = await import("../../open-sse/services/providerModelsImport.js");
    const cfg = buildOpenAIFallbackModelsConfig("https://api.cline.bot/api/v1/models", "cline");
    expect(cfg.authHeader).toBe("Authorization");
    expect(cfg.headers["HTTP-Referer"]).toBe("https://cline.bot");
  });
});

describe("connectionSupportsModelsImport oauth", () => {
  it("iflow connection try_openai or explicit/fallback", () => {
    const r = connectionSupportsModelsImport({ provider: "iflow" });
    expect(r.supported).toBe(true);
  });
});

describe("connectionSupportsModelsImport", () => {
  it("compatible node", () => {
    expect(connectionSupportsModelsImport({ provider: "openai-compatible-chat-x" }).supported).toBe(true);
  });
});

describe("getImportModelsUiState", () => {
  it("hides unsupported provider", () => {
    const s = getImportModelsUiState({ providerId: "totally-unknown-provider-xyz", connections: [] });
    expect(s.show).toBe(false);
    expect(s.hint).toMatch(/not in the 9router provider registry/);
  });

  it("disables when no connection", () => {
    const s = getImportModelsUiState({ providerId: "openai", connections: [] });
    expect(s.show).toBe(true);
    expect(s.disabled).toBe(true);
  });
});