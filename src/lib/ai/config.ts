import "server-only";

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

export function hasGeminiKey(): boolean {
  return Boolean(geminiApiKey());
}

/** Used for streaming chat and the tool-calling agent loop (up to MAX_TOOL_ITERATIONS turns/question — see src/lib/actions/agent.ts) — the one path that genuinely needs a full Flash-tier model's reasoning/tool-use quality. Verify this id against https://ai.google.dev/gemini-api/docs/models before relying on the default; override via GEMINI_CHAT_MODEL if it's changed or wrong for your account. */
export function chatModel(): string {
  return process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash";
}

export function embeddingModel(): string {
  return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
}

/**
 * Used for collection-overview/collection-gaps — single-shot structured
 * JSON generation, not tool-calling — so it deliberately does NOT default
 * to chatModel(). Google buckets Flash-Lite's free-tier daily quota
 * separately from Flash's, so pointing this at a Flash-Lite model gives
 * these calls their own quota instead of competing with chat/agent traffic
 * for the same bucket, on top of being the cheaper tier per token. Verify
 * this id against current docs the same as chatModel(); override via
 * GEMINI_ANALYSIS_MODEL.
 */
export function analysisModel(): string {
  return process.env.GEMINI_ANALYSIS_MODEL || "gemini-3.1-flash-lite";
}
