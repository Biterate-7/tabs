import { REDUNDANCY_NOTES, REDUNDANCY_THRESHOLD, RedundancyIndex, buildSignature } from "./redundancy";
import type { RedundancyReason } from "./redundancy";
import type { HistoryCandidate } from "./types";

/**
 * What "Select suggested" actually selects. Browsing history is a research
 * journey, not a list of independent resources — one afternoon of reading
 * leaves behind a search, its variation, the article, the article again via
 * a tracking link, the video, the video again with a timestamp. Selecting
 * every suggested-tier candidate faithfully reproduces that journey; what
 * the user wants is the handful of resources it *produced*.
 *
 * This layer sits strictly on top of the existing relevance system: the
 * candidates arrive already filtered (filter.ts), folded by canonical
 * resource (aggregate.ts), scored (score.ts) and tiered, and this function
 * never rescues a candidate that tiering rejected or reorders one above a
 * better-scoring peer. It only ever declines a slot — and only when there
 * is strong evidence the slot would be spent on something already covered.
 * When the evidence is weak, the candidate is kept: a redundant tab is a
 * small annoyance, a silently dropped one is a lost page.
 */

export type SkippedSuggestion = {
  id: string;
  reason: RedundancyReason;
  /** Short user-facing explanation, e.g. "Similar to another selected tab". */
  note: string;
};

export type DiverseSelection = {
  /** Ids to select, in the order they were chosen (strongest first). */
  selectedIds: string[];
  /** Candidates passed over, with why — surfaced in the review list so the selection never looks arbitrary. */
  skipped: SkippedSuggestion[];
};

/**
 * Greedily walks candidates strongest-first, keeping each one whose
 * marginal value over everything already kept is high enough. Because the
 * index only grows as candidates are kept, a candidate's fate depends on
 * what was selected before it — which is exactly what stops ten variations
 * of one page from taking all ten slots.
 *
 * `alreadyInWorkspace` candidates are skipped defensively; the review UI
 * already excludes them from the suggested list, and a page the workspace
 * holds is by definition covered.
 */
export function selectDiverseSuggestions(
  candidates: readonly HistoryCandidate[],
  options: { threshold?: number } = {}
): DiverseSelection {
  const threshold = options.threshold ?? REDUNDANCY_THRESHOLD;

  // Sorted defensively rather than trusting the caller's order: "the
  // higher-scoring of two redundant pages wins" only holds if the stronger
  // one is considered first. Ties fall to the more recently visited page,
  // matching candidates.ts's own ordering.
  const ranked = [...candidates].sort((a, b) => b.score - a.score || b.lastVisitedAt - a.lastVisitedAt);

  const index = new RedundancyIndex();
  const selectedIds: string[] = [];
  const skipped: SkippedSuggestion[] = [];

  for (const candidate of ranked) {
    if (candidate.alreadyInWorkspace) continue;

    const signature = buildSignature(candidate);
    const { score, reason } = index.assess(signature);

    if (reason && score >= threshold) {
      skipped.push({ id: candidate.id, reason, note: REDUNDANCY_NOTES[reason] });
      continue;
    }

    index.add(signature);
    selectedIds.push(candidate.id);
  }

  return { selectedIds, skipped };
}
