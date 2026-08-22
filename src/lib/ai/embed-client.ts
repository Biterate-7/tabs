export type EmbedBatchResult = { ok: true; embeddings: number[][] } | { ok: false; error: string };

const MAX_BATCH = 100;

/** Embeds up to 100 texts in one request against /api/ai/embed. Callers batch larger sets themselves. */
export async function embedTexts(texts: string[]): Promise<EmbedBatchResult> {
  if (texts.length === 0) return { ok: true, embeddings: [] };

  try {
    const response = await fetch("/api/ai/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: texts.slice(0, MAX_BATCH) }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return { ok: false, error: (data && data.error) || `Embedding request failed (${response.status}).` };
    }
    if (!data || !Array.isArray(data.embeddings)) {
      return { ok: false, error: "Malformed embedding response." };
    }
    return { ok: true, embeddings: data.embeddings };
  } catch {
    return { ok: false, error: "Couldn't reach the embedding service." };
  }
}
