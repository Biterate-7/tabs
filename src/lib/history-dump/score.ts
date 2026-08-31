import { classifyUrl } from "@/lib/categories";
import type { AggregatedHistoryEntry } from "./aggregate";

/**
 * Deterministic, fully local relevance scoring (AGENTS.md section 7): no AI
 * call, same input always produces the same output. Four signals, each
 * capped so no single one can dominate: recency, visit frequency, title
 * quality, and content-type (via the same category classifier the rest of
 * TabDump uses — reusing it here means "this looks like research/news/docs"
 * is one classifier, not a second guess specific to History Dump).
 */
const MAX_SCORE = 100;
const RECENCY_MAX = 40;
const RECENCY_DECAY_DAYS = 20; // score reaches 0 recency contribution after this many days
const VISIT_MAX = 30;
const VISIT_POINTS_PER_VISIT = 6;
const TITLE_BONUS = 10;
const MIN_MEANINGFUL_TITLE_LENGTH = 8;
const CATEGORY_MAX = 10;
const MULTI_DAY_BONUS = 10;

/** Score at/above this is "suggested" (higher-confidence); below is "other potential tabs" — see AGENTS.md section 9/11. */
export const SUGGESTED_SCORE_THRESHOLD = 45;

function daysSince(ms: number, now: number): number {
  return Math.max(0, (now - ms) / (24 * 60 * 60 * 1000));
}

export function scoreHistoryEntry(entry: AggregatedHistoryEntry, now: number): number {
  const recency = Math.max(0, RECENCY_MAX * (1 - daysSince(entry.lastVisitedAt, now) / RECENCY_DECAY_DAYS));
  const visits = Math.min(VISIT_MAX, entry.visitCount * VISIT_POINTS_PER_VISIT);
  const titleQuality = (entry.title?.trim().length ?? 0) >= MIN_MEANINGFUL_TITLE_LENGTH ? TITLE_BONUS : 0;

  let category = 0;
  try {
    category = classifyUrl(entry.normalizedUrl).confidence * CATEGORY_MAX;
  } catch {
    category = 0;
  }

  const multiDay = entry.distinctDayCount >= 2 ? MULTI_DAY_BONUS : 0;

  return Math.min(MAX_SCORE, Math.round(recency + visits + titleQuality + category + multiDay));
}

function relativeDayLabel(ms: number, now: number): string {
  const days = Math.floor(daysSince(ms, now));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Human-readable signals backing a score (AGENTS.md section 8) — the score
 * itself is never shown, only what produced it. Always starts with visit
 * count + recency (the two signals every candidate has); a headline label
 * ("Frequently visited" etc.) is chosen separately by `candidateLabel`.
 */
export function describeHistoryEntry(entry: AggregatedHistoryEntry, now: number): string[] {
  const visits = entry.visitCount <= 1 ? "Visited once" : `Visited ${entry.visitCount} times`;
  const lastVisited = `Last visited ${relativeDayLabel(entry.lastVisitedAt, now)}`;
  return [visits, lastVisited];
}

export function candidateLabel(entry: AggregatedHistoryEntry, now: number): string {
  if (entry.visitCount >= 5) return "Frequently visited";
  if (entry.distinctDayCount >= 2 || entry.visitCount >= 2) return "Revisited";
  if (daysSince(entry.lastVisitedAt, now) <= 1) return "Recently visited";
  return "Potentially useful";
}
