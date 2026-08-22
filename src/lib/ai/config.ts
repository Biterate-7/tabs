import "server-only";

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

export function hasGeminiKey(): boolean {
  return Boolean(geminiApiKey());
}

export function chatModel(): string {
  return process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";
}

export function embeddingModel(): string {
  return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
}

export function analysisModel(): string {
  return process.env.GEMINI_ANALYSIS_MODEL || chatModel();
}
