import { parseSingleUrl } from "@/lib/tabs/parse";
import { canonicalResourceKey } from "./resource-key";
import type { HistoryVisitItem } from "@/lib/browser/protocol";

/**
 * One *resource's* combined history, folded together from every raw variant
 * chrome.history.search returned for it (e.g. the same article visited with
 * and without a `utm_source` param, or one video opened both bare and at a
 * timestamp). This is the unit score.ts and candidates.ts operate on —
 * never the raw per-visit items, so a page visited under three URL variants
 * scores (and is reviewed) as one page, not three.
 */
export type AggregatedHistoryEntry = {
  url: string;
  normalizedUrl: string;
  /** Canonical key every raw variant folded into this entry shares — see resource-key.ts. */
  resourceKey: string;
  domain: string;
  title?: string;
  visitCount: number;
  lastVisitedAt: number;
  /** Count of distinct calendar days across the raw items folded into this entry — a conservative proxy for "researched more than once," see score.ts. Only reflects variance chrome.history.search actually reported (different URL variants with different lastVisitTime); it cannot see multi-day visits to one exact URL, which Chrome itself already collapses into a single item's visitCount. */
  distinctDayCount: number;
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Prefers a non-empty, more informative title over a shorter/blank one when merging duplicate variants. */
function betterTitle(a: string | undefined, b: string | undefined): string | undefined {
  const at = a?.trim();
  const bt = b?.trim();
  if (!at) return bt || undefined;
  if (!bt) return at;
  return bt.length > at.length ? bt : at;
}

/**
 * Groups already-filtered raw history items by canonical resource — reusing
 * `parseSingleUrl` (the exact same parser `parseUrls`/browser-import use) so
 * there is exactly one notion of "what a URL normalizes to" in this
 * codebase, never a second history-specific one, and then folding one step
 * further with `canonicalResourceKey` because history (unlike a live tab
 * list) records the same page under share links, `www.` variants and
 * playback timestamps that `normalizeUrl` deliberately keeps apart. Each
 * entry still reports the `normalizedUrl` of its most recently visited
 * variant, so what gets dumped is a real URL the user actually opened.
 *
 * Items whose URL fails to parse are dropped silently; `isNoiseUrl` should
 * already have caught anything unparseable, but this stays defensive rather
 * than assuming that.
 */
export function aggregateHistoryEntries(items: HistoryVisitItem[]): AggregatedHistoryEntry[] {
  const byResourceKey = new Map<string, Omit<AggregatedHistoryEntry, "distinctDayCount"> & { days: Set<number> }>();

  for (const item of items) {
    const parsed = parseSingleUrl(item.url);
    if (!parsed) continue;

    const resourceKey = canonicalResourceKey(parsed.normalizedUrl);
    const existing = byResourceKey.get(resourceKey);
    const day = startOfDay(item.lastVisitTime || 0);

    if (!existing) {
      byResourceKey.set(resourceKey, {
        url: item.url,
        normalizedUrl: parsed.normalizedUrl,
        resourceKey,
        domain: parsed.domain,
        title: item.title?.trim() || undefined,
        visitCount: Math.max(0, item.visitCount || 0),
        lastVisitedAt: item.lastVisitTime || 0,
        days: new Set([day]),
      });
      continue;
    }

    existing.visitCount += Math.max(0, item.visitCount || 0);
    existing.days.add(day);
    if (item.lastVisitTime > existing.lastVisitedAt) {
      existing.lastVisitedAt = item.lastVisitTime;
      // Keep the most recently visited variant as the representative url —
      // it is the form the user most recently saw the page in.
      existing.url = item.url;
      existing.normalizedUrl = parsed.normalizedUrl;
    }
    existing.title = betterTitle(existing.title, item.title);
  }

  return Array.from(byResourceKey.values()).map(({ days, ...entry }) => ({
    ...entry,
    distinctDayCount: days.size,
  }));
}
