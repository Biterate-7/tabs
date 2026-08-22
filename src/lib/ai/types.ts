/**
 * Every /api/ai/* error response is `{ error: string, detail?: string }` —
 * `error` is the user-facing summary, `detail` (when present) is Gemini's
 * own error message, safe to show since it never contains our API key.
 * Folding them into one string keeps the real cause visible in the UI
 * instead of a bare generic fallback.
 */
export function formatApiError(data: unknown, fallbackStatus: number): string {
  const d = data as { error?: string; detail?: string } | null;
  const base = d?.error || `Request failed (${fallbackStatus}).`;
  return d?.detail ? `${base} (${d.detail})` : base;
}

/** Wire type shared between /api/ai/content and its client caller. */
export type ContentApiResult =
  | { url: string; ok: true; description?: string; text?: string }
  | { url: string; ok: false };

export type ChunkKind = "summary" | "body";

/** One embeddable unit of text derived from a tab. */
export type TabChunk = {
  tabId: string;
  kind: ChunkKind;
  text: string;
};

/** What's persisted in IndexedDB per chunk. */
export type IndexedChunkRecord = {
  key: string; // `${workspaceId}:${tabId}:${kind}`
  workspaceId: string;
  tabId: string;
  kind: ChunkKind;
  text: string;
  embedding: number[];
  /** tabSignature() at index time — lets the indexer skip unchanged tabs without a network call. */
  tabSignature: string;
  title: string;
  url: string;
  indexedAt: number;
};

export type RetrievedChunk = IndexedChunkRecord & { score: number };

export type AskSource = {
  tabId: string;
  title: string;
  url: string;
  domain: string;
  category?: string;
};

export type AskRole = "user" | "assistant";

export type AskMessage = {
  id: string;
  role: AskRole;
  text: string;
  sources?: AskSource[];
  /** True while an assistant message's text is still streaming in. */
  pending?: boolean;
};

export type CollectionOverview = {
  overview: string;
  themes: string[];
  importantResources: AskSource[];
  keyInsights: string[];
};

export type CollectionGaps = {
  covered: string[];
  gaps: string[];
};
