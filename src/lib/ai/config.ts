import "server-only";

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

export function hasGeminiKey(): boolean {
  return Boolean(geminiApiKey());
}

/** Used to embed tab content for Auto-Organize's optional semantic clustering hints (see src/lib/ai/cluster.ts) — the only remaining use of Gemini in the app. */
export function embeddingModel(): string {
  return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
}
