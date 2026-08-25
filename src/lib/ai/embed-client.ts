import { formatApiError } from "./types";

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
      return { ok: false, error: formatApiError(data, response.status) };
    }
    if (!data || !Array.isArray(data.embeddings)) {
      return { ok: false, error: "Malformed embedding response." };
    }
    return { ok: true, embeddings: data.embeddings };
  } catch (err) {
    // A rejected fetch() here is always a network-level failure (DNS, connection
    // refused, the tab briefly losing its origin during a server restart, etc.)
    // — never an HTTP error, which is handled by the !response.ok branch above
    // via formatApiError. err.message on a browser fetch TypeError (e.g. "Failed
    // to fetch") is safe to surface as-is: it's a generic browser-generated
    // string, never request data, headers, or a stack trace.
    const detail = err instanceof Error ? err.message : undefined;
    return { ok: false, error: detail ? `Couldn't reach the embedding service. (${detail})` : "Couldn't reach the embedding service." };
  }
}
