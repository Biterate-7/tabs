/**
 * Domain types for History Dump (see AGENTS.md's History Dump spec). Mirrors
 * the shape of other TabDump domain modules (organize/types.ts, workspace/
 * types.ts): plain data types here, pure logic in sibling files, no React.
 */

export type HistoryTimeRangeId = "today" | "3d" | "7d" | "30d" | "custom";

export type HistoryTimeRange = {
  id: HistoryTimeRangeId;
  label: string;
};

/** Order matches the spec's list; "custom" is always last since it needs its own date inputs. */
export const HISTORY_TIME_RANGES: HistoryTimeRange[] = [
  { id: "today", label: "Today" },
  { id: "3d", label: "Last 3 days" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "custom", label: "Custom" },
];

export const DEFAULT_HISTORY_TIME_RANGE: HistoryTimeRangeId = "7d";

/** Which of the two review tiers a candidate landed in — see score.ts's SUGGESTED_SCORE_THRESHOLD. */
export type HistoryCandidateTier = "suggested" | "other";

/**
 * One deduplicated, scored history page awaiting the user's review. Distinct
 * from `Tab` (src/lib/tabs/types.ts) on purpose: a candidate is provisional
 * data about a *history entry*, not yet a workspace tab — it only becomes one
 * if the user selects it and it goes through buildTabsFromBrowserImport, at
 * which point candidate-only fields like `score`/`tier`/`reasons` are dropped
 * and never persisted (AGENTS.md section 18: don't store more history
 * metadata than what's actually dumped).
 */
export type HistoryCandidate = {
  /** Stable within one scan session — derived from normalizedUrl, not persisted. */
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  title?: string;
  visitCount: number;
  lastVisitedAt: number;
  /** Deterministic 0-100 relevance score — see score.ts. Never shown to the user directly (AGENTS.md section 8). */
  score: number;
  tier: HistoryCandidateTier;
  /** Short human-readable signals backing the score, e.g. "Visited 8 times", "Last visited today" — see score.ts's describeCandidate. */
  reasons: string[];
  /** True when this normalized URL already exists somewhere in the current workspace — see candidates.ts. Such candidates are always informational-only, never selectable for dumping. */
  alreadyInWorkspace: boolean;
};

export type HistoryScanStage = "idle" | "scanning" | "ready" | "error";

export type HistoryScanErrorReason = "not-connected" | "no-permission" | "error";

export type HistoryScanResult = {
  candidates: HistoryCandidate[];
  /** Raw history entries considered, before noise filtering — for the "N pages scanned" / empty-state messaging. */
  scannedCount: number;
};
