import "server-only";

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

export function hasGeminiKey(): boolean {
  return Boolean(geminiApiKey());
}

/** Used to embed tab content for Auto-Organize's optional semantic clustering hints (see src/lib/ai/cluster.ts). */
export function embeddingModel(): string {
  return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
}

/**
 * Used for the batch-level section-organization text-generation call (see
 * src/lib/sections/ai/organize.ts) — the app's only text-generation Gemini
 * call. Defaults to Google's stable rolling alias (always the current
 * recommended flash model) rather than a dated model id, so this never goes
 * stale the way a pinned id eventually does when Google retires it.
 */
export function generationModel(): string {
  return process.env.GEMINI_GENERATION_MODEL || "gemini-flash-lite-latest";
}
