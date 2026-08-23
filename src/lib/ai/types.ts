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

/** One write action proposed by the agent — mirrors src/lib/actions/plan.ts's PlannedAction (kept as a separate, minimal type here so the UI layer doesn't need to import the server-only action layer). */
export type PlannedActionView = {
  name: string;
  args: unknown;
  label: string;
  affected: number;
};

export type PendingActionPreviewStatus = "awaiting" | "applying" | "applied" | "cancelled" | "failed";

/** Attached to an assistant message when the agent proposed changes that need explicit approval before anything is applied. */
export type PendingActionPreview = {
  plan: PlannedActionView[];
  summary: string;
  status: PendingActionPreviewStatus;
};

export type UndoActionStatus = "available" | "undoing" | "undone" | "unavailable";

/** Attached to an assistant message that reported a successful mutation — lets the user immediately revert exactly that change. See src/lib/undo. */
export type UndoAction = {
  entryId: string;
  status: UndoActionStatus;
};

export type AskMessage = {
  id: string;
  role: AskRole;
  text: string;
  sources?: AskSource[];
  /** True while an assistant message's text is still streaming in. */
  pending?: boolean;
  /** Present on an assistant message that proposed a plan awaiting (or resolved from) user approval. */
  preview?: PendingActionPreview;
  /** Present on an assistant message that made a change the user can undo. */
  undo?: UndoAction;
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
