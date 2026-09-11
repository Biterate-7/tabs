import { isNoiseUrl } from "./filter";
import { aggregateHistoryEntries } from "./aggregate";
import { canonicalResourceKey } from "./resource-key";
import { scoreHistoryEntry, describeHistoryEntry, candidateLabel, SUGGESTED_SCORE_THRESHOLD } from "./score";
import type { HistoryVisitItem } from "@/lib/browser/protocol";
import type { HistoryCandidate, HistoryScanResult } from "./types";

/**
 * The full history → candidates pipeline (AGENTS.md section 5/6/7/11/12):
 * filter noise → fold duplicate URL variants into one resource → score →
 * mark what's already in the workspace → sort → tier into suggested/other.
 * Pure and synchronous so it's trivially unit-testable and so the UI layer
 * owns all async/loading concerns — this function just transforms data.
 * Near-duplicate handling deliberately does NOT live here: two distinct
 * resources are both worth *reviewing*, and only compete once something has
 * to choose between them (see select.ts).
 *
 * `existingNormalizedUrls` should be every `normalizedUrl` already present in
 * the *current* workspace (see lib/tabs/normalize.ts) — candidates matching
 * one are flagged `alreadyInWorkspace` rather than excluded outright, so the
 * review UI can still show "you already have this" instead of silently
 * hiding it. Matching is by canonical resource as well as exact URL, since a
 * saved `watch?v=X` and a freshly browsed `watch?v=X&t=90` are the same page
 * and dumping the second would leave the workspace holding it twice.
 */
export function buildHistoryCandidates(
  items: HistoryVisitItem[],
  existingNormalizedUrls: ReadonlySet<string>,
  now: number = Date.now()
): HistoryScanResult {
  const filtered = items.filter((item) => !isNoiseUrl(item.url, item.title));
  const aggregated = aggregateHistoryEntries(filtered);
  const existingResourceKeys = new Set([...existingNormalizedUrls].map(canonicalResourceKey));

  const candidates: HistoryCandidate[] = aggregated
    .map((entry) => {
      const score = scoreHistoryEntry(entry, now);
      return {
        id: `history-${entry.resourceKey}`,
        url: entry.url,
        normalizedUrl: entry.normalizedUrl,
        resourceKey: entry.resourceKey,
        domain: entry.domain,
        title: entry.title,
        visitCount: entry.visitCount,
        lastVisitedAt: entry.lastVisitedAt,
        score,
        tier: score >= SUGGESTED_SCORE_THRESHOLD ? "suggested" : "other",
        reasons: [candidateLabel(entry, now), ...describeHistoryEntry(entry, now)],
        alreadyInWorkspace:
          existingNormalizedUrls.has(entry.normalizedUrl) || existingResourceKeys.has(entry.resourceKey),
      } satisfies HistoryCandidate;
    })
    .sort((a, b) => b.score - a.score || b.lastVisitedAt - a.lastVisitedAt);

  return { candidates, scannedCount: items.length };
}
