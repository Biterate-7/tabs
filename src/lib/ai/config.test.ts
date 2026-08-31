import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ai/config", () => {
  it("defaults the embedding model to gemini-embedding-001 when GEMINI_EMBEDDING_MODEL is unset", async () => {
    vi.stubEnv("GEMINI_EMBEDDING_MODEL", "");
    const { embeddingModel } = await import("./config");
    expect(embeddingModel()).toBe("gemini-embedding-001");
  });

  it("respects GEMINI_EMBEDDING_MODEL when set", async () => {
    vi.stubEnv("GEMINI_EMBEDDING_MODEL", "gemini-custom-embedding-model");
    const { embeddingModel } = await import("./config");
    expect(embeddingModel()).toBe("gemini-custom-embedding-model");
  });

  it("has no API key configured by default in tests", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { hasGeminiKey } = await import("./config");
    expect(hasGeminiKey()).toBe(false);
  });

  it("reports a key as present once GEMINI_API_KEY is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { hasGeminiKey, geminiApiKey } = await import("./config");
    expect(hasGeminiKey()).toBe(true);
    expect(geminiApiKey()).toBe("test-key");
  });
});
