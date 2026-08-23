import type { MatchReason, SearchResult, SearchResultSource } from "@/lib/search/types";
import type { OrganizationPlan } from "@/lib/organize/types";

export type { MatchReason, SearchResult, SearchResultSource, OrganizationPlan };

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

/**
 * One action the server actually ran (or tried to) — mirrors
 * src/lib/actions/agent.ts's PerformedAction / plan.ts's AppliedAction.
 * `args`/`data` are only ever present for browser actions (see
 * BROWSER_ACTION_NAMES) — this is what src/lib/browser/execute.ts needs to
 * actually carry out a browser action for real once the server's response
 * comes back (see AGENTS.md's architectural constraint: the server can
 * validate but never itself call chrome.*).
 */
export type PerformedActionView = {
  name: string;
  ok: boolean;
  message: string;
  args?: unknown;
  data?: unknown;
};

export type PendingActionPreviewStatus = "awaiting" | "applying" | "applied" | "cancelled" | "failed";

/** Attached to an assistant message when the agent proposed changes that need explicit approval before anything is applied. */
export type PendingActionPreview = {
  plan: PlannedActionView[];
  summary: string;
  status: PendingActionPreviewStatus;
};

export type UndoActionStatus = "available" | "undoing" | "undone" | "unavailable";

/**
 * Attached to an assistant message that reported a successful mutation —
 * lets the user immediately revert exactly that change. See src/lib/undo.
 * `secondaryEntryId` is set only when one turn produced BOTH a TabDump store
 * mutation AND a revertible browser mutation (e.g. "move these tabs to MUN
 * and open them") — undoing then reverts both under the one button, rather
 * than silently only restoring the store half and leaving the opened tabs
 * behind. `entryId`/`secondaryEntryId` may each independently belong to
 * either undo history (store or browser — see src/lib/undo/history.ts and
 * src/lib/browser/undo.ts); useAskTabDump's undoAction checks both.
 */
export type UndoAction = {
  entryId: string;
  secondaryEntryId?: string;
  status: UndoActionStatus;
};

export type PendingOrganizePreviewStatus = "awaiting" | "applying" | "applied" | "cancelled" | "failed";

/** Attached to an assistant message that proposed an Auto-Organize plan awaiting (or resolved from) user approval — the Auto-Organize counterpart to PendingActionPreview. See src/lib/organize. */
export type PendingOrganizePreview = {
  plan: OrganizationPlan;
  status: PendingOrganizePreviewStatus;
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
  /** Present on an assistant message that proposed an Auto-Organize plan — see AutoOrganizeReview. */
  organizePreview?: PendingOrganizePreview;
  /** Present on an assistant message that made a change the user can undo. */
  undo?: UndoAction;
  /** Present on an assistant message that ran a global search — see src/lib/search. */
  searchResults?: SearchResult[];
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
