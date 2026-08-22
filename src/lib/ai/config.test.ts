import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ai/config", () => {
  it("defaults the chat model to gemini-3.6-flash when GEMINI_CHAT_MODEL is unset", async () => {
    vi.stubEnv("GEMINI_CHAT_MODEL", "");
    const { chatModel } = await import("./config");
    expect(chatModel()).toBe("gemini-3.6-flash");
  });

  it("respects GEMINI_CHAT_MODEL when set", async () => {
    vi.stubEnv("GEMINI_CHAT_MODEL", "gemini-custom-model");
    const { chatModel } = await import("./config");
    expect(chatModel()).toBe("gemini-custom-model");
  });

  it("defaults the analysis model to the chat model when GEMINI_ANALYSIS_MODEL is unset", async () => {
    vi.stubEnv("GEMINI_ANALYSIS_MODEL", "");
    vi.stubEnv("GEMINI_CHAT_MODEL", "");
    const { analysisModel } = await import("./config");
    expect(analysisModel()).toBe("gemini-3.6-flash");
  });
});
