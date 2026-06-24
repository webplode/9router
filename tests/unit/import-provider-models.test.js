import { describe, it, expect } from "vitest";
import { normalizeImportedModelId } from "../../src/shared/utils/importProviderModels.js";

describe("normalizeImportedModelId", () => {
  it("strips gemini models/ prefix", () => {
    expect(normalizeImportedModelId("models/gemini-2.0-flash", "gemini")).toBe("gemini-2.0-flash");
  });

  it("takes last segment for qoder-style ids", () => {
    expect(normalizeImportedModelId("qoder/auto", "qoder")).toBe("auto");
  });

  it("returns plain id", () => {
    expect(normalizeImportedModelId("gpt-4o", "openai")).toBe("gpt-4o");
  });
});