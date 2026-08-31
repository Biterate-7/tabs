import { isNoiseUrl } from "./filter";
import { aggregateHistoryEntries } from "./aggregate";
import { scoreHistoryEntry, describeHistoryEntry, candidateLabel, SUGGESTED_SCORE_THRESHOLD } from "./score";
import type { HistoryVisitItem } from "@/lib/browser/protocol";
import type { HistoryCandidate, HistoryScanResult } from "./types";

/**
 * The full history → candidates pipeline (AGENTS.md section 5/6/7/11/12):
 * filter noise → aggregate duplicate URL variants → score → mark what's
 * already in the workspace → sort → tier into suggested/other. Pure and
 * synchronous so it's trivially unit-testable and so the UI layer owns all
 * async/loading concerns — this function just transforms data.
 *
 * `existingNormalizedUrls` should be every `normalizedUrl` already present in
 * the *current* workspace (see lib/tabs/normalize.ts) — candidates matching
 * one are flagged `alreadyInWorkspace` rather than excluded outright, so the
 * review UI can still show "you already have this" instead of silently
 * hiding it.
 */
export function buildHistoryCandidates(
  items: HistoryVisitItem[],
  existingNormalizedUrls: ReadonlySet<string>,
  now: number = Date.now()
): HistoryScanResult {
  const filtered = items.filter((item) => !isNoiseUrl(item.url, item.title));
  const aggregated = aggregateHistoryEntries(filtered);

  const candidates: HistoryCandidate[] = aggregated
    .map((entry) => {
      const score = scoreHistoryEntry(entry, now);
      return {
        id: `history-${entry.normalizedUrl}`,
        url: entry.url,
        normalizedUrl: entry.normalizedUrl,
        domain: entry.domain,
        title: entry.title,
        visitCount: entry.visitCount,
        lastVisitedAt: entry.lastVisitedAt,
        score,
        tier: score >= SUGGESTED_SCORE_THRESHOLD ? "suggested" : "other",
        reasons: [candidateLabel(entry, now), ...describeHistoryEntry(entry, now)],
        alreadyInWorkspace: existingNormalizedUrls.has(entry.normalizedUrl),
      } satisfies HistoryCandidate;
    })
    .sort((a, b) => b.score - a.score || b.lastVisitedAt - a.lastVisitedAt);

  return { candidates, scannedCount: items.length };
}
