import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isCompatibleProviderId,
  isCustomEmbeddingProviderId,
} from "../../open-sse/services/compatibleProvider.js";
import { isPassthroughNodeProvider } from "../../src/sse/services/compatibleRetry.js";

const originalDataDir = process.env.DATA_DIR;

describe("compatible provider retry policy helpers", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-retry-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("detects openai-compatible node ids", () => {
    expect(isCompatibleProviderId("openai-compatible-chat-abc")).toBe(true);
  });

  it("detects anthropic-compatible node ids", () => {
    expect(isCompatibleProviderId("anthropic-compatible-xyz")).toBe(true);
  });

  it("rejects oauth providers", () => {
    expect(isCompatibleProviderId("claude")).toBe(false);
  });

  it("detects custom-embedding nodes", () => {
    expect(isCustomEmbeddingProviderId("custom-embedding-abc")).toBe(true);
  });

  it("passthrough union includes embedding nodes", () => {
    expect(isPassthroughNodeProvider("custom-embedding-x")).toBe(true);
    expect(isPassthroughNodeProvider("claude")).toBe(false);
  });

  it("normalizes max retries when create receives a numeric string", async () => {
    const { createProviderNode } = await import("../../src/lib/db/repos/nodesRepo.js");
    const node = await createProviderNode({
      type: "openai-compatible",
      name: "Compat",
      prefix: "compat",
      baseUrl: "https://api.example.test/v1",
      maxRetriesOnError: "25",
    });
    expect(node.maxRetriesOnError).toBe(25);
  });
});