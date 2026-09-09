import { isNoiseUrl } from "./filter";
import { aggregateHistoryEntries } from "./aggregate";
import { canonicalizeHistoryUrl } from "./canonical";
import { scoreHistoryEntry, describeHistoryEntry, candidateLabel, SUGGESTED_SCORE_THRESHOLD } from "./score";
import type { HistoryVisitItem } from "@/lib/browser/protocol";
import type { HistoryCandidate, HistoryScanResult } from "./types";

/**
 * The full history → candidates pipeline (AGENTS.md section 5/6/7/11/12):
 * filter noise → canonicalize and collapse duplicate representations of the
 * same page → score → mark what's already in the workspace → sort → tier into
 * suggested/other. Pure and synchronous so it's trivially unit-testable and so
 * the UI layer owns all async/loading concerns — this function just transforms
 * data.
 *
 * Canonicalization/deduplication (see canonical.ts + aggregate.ts) happens
 * here, before anything semantic: what leaves this function is one candidate
 * per logical page, so the AI organization pipeline and the graph downstream
 * only ever see canonical entities — never twenty variants of one inbox that
 * they would then have to recognize as the same thing.
 *
 * `existingNormalizedUrls` should be every `normalizedUrl` already present in
 * the *current* workspace (see lib/tabs/normalize.ts) — candidates matching
 * one are flagged `alreadyInWorkspace` rather than excluded outright, so the
 * review UI can still show "you already have this" instead of silently
 * hiding it. Matching is by canonical identity as well as by exact
 * normalizedUrl, so a saved tab and its tracking-param variant in history
 * count as the same page here too.
 */
export function buildHistoryCandidates(
  items: HistoryVisitItem[],
  existingNormalizedUrls: ReadonlySet<string>,
  now: number = Date.now()
): HistoryScanResult {
  const filtered = items.filter((item) => !isNoiseUrl(item.url, item.title));
  const aggregated = aggregateHistoryEntries(filtered);

  const existingCanonicalKeys = new Set<string>();
  for (const url of existingNormalizedUrls) {
    const identity = canonicalizeHistoryUrl(url);
    if (identity) existingCanonicalKeys.add(identity.key);
  }

  const candidates: HistoryCandidate[] = aggregated
    .map((entry) => {
      const score = scoreHistoryEntry(entry, now);
      const mergedNote =
        entry.occurrenceCount > 1 ? [`Merged ${entry.occurrenceCount} history entries`] : [];
      return {
        id: `history-${entry.canonicalKey}`,
        canonicalKey: entry.canonicalKey,
        url: entry.url,
        normalizedUrl: entry.normalizedUrl,
        domain: entry.domain,
        title: entry.title,
        visitCount: entry.visitCount,
        lastVisitedAt: entry.lastVisitedAt,
        occurrenceCount: entry.occurrenceCount,
        occurrences: entry.occurrences,
        score,
        tier: score >= SUGGESTED_SCORE_THRESHOLD ? "suggested" : "other",
        reasons: [candidateLabel(entry, now), ...describeHistoryEntry(entry, now), ...mergedNote],
        alreadyInWorkspace:
          existingNormalizedUrls.has(entry.normalizedUrl) || existingCanonicalKeys.has(entry.canonicalKey),
      } satisfies HistoryCandidate;
    })
    .sort((a, b) => b.score - a.score || b.lastVisitedAt - a.lastVisitedAt);

  return { candidates, scannedCount: items.length };
}
