import { parseSingleUrl } from "@/lib/tabs/parse";
import { canonicalizeHistoryUrl, canonicalizeTitle, duplicateConfidence } from "./canonical";
import type { CanonicalIdentity, CanonicalTitle } from "./canonical";
import type { HistoryVisitItem } from "@/lib/browser/protocol";

/**
 * One logical page, folded together from every raw history entry that turned
 * out to be a representation of it — the same article reached with and
 * without a `utm_source`, the same inbox reached as `outlook…/mail/0/` and
 * `outlook…/mail/0/inbox/id/AAMkAD…`, the same page seen with `www.` and
 * without. This is the unit score.ts and candidates.ts operate on — never the
 * raw per-visit items — so a page reached eight different ways is scored,
 * reviewed, dumped, and drawn in Graph as one page, not eight.
 *
 * Deduplication never *discards* history: every raw item that went into an
 * entry is kept on `occurrences`, so anything downstream that wants the
 * underlying history detail still has all of it.
 */
export type AggregatedHistoryEntry = {
  /**
   * Stable canonical identity for this logical page within one scan (see
   * canonical.ts). Derived, never persisted — candidates.ts uses it for a
   * candidate's id, and app-shell compares dumped tabs by `normalizedUrl`
   * exactly as before.
   */
  canonicalKey: string;
  /** The representative raw URL — the most recent, most useful occurrence (see pickRepresentative). */
  url: string;
  normalizedUrl: string;
  domain: string;
  title?: string;
  /** Sum of `visitCount` across every folded occurrence. */
  visitCount: number;
  lastVisitedAt: number;
  /** Count of distinct calendar days across the raw items folded into this entry — a conservative proxy for "researched more than once," see score.ts. Only reflects variance chrome.history.search actually reported (different URL variants with different lastVisitTime); it cannot see multi-day visits to one exact URL, which Chrome itself already collapses into a single item's visitCount. */
  distinctDayCount: number;
  /** Every raw history entry behind this logical page, newest first. Length is `occurrenceCount`; 1 means nothing was merged. */
  occurrences: HistoryVisitItem[];
  occurrenceCount: number;
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

type Occurrence = {
  item: HistoryVisitItem;
  url: string;
  normalizedUrl: string;
  domain: string;
  identity: CanonicalIdentity;
};

type WorkingEntry = {
  identity: CanonicalIdentity;
  title: CanonicalTitle;
  representative: Occurrence;
  displayTitle?: string;
  visitCount: number;
  lastVisitedAt: number;
  days: Set<number>;
  occurrences: HistoryVisitItem[];
  /** Index of this entry's earliest occurrence in the input, so output order stays the input's first-seen order. */
  firstSeenIndex: number;
};

/**
 * Which of two occurrences better represents the logical page, in the order
 * the History Dump review UI cares about: most recent first (a page's newest
 * visit is the one the user actually remembers), then most-visited, then the
 * more specific URL — an inbox thread URL says more than the bare service
 * root — then the shorter/lexically-first URL purely so the choice is
 * deterministic for identical inputs.
 */
function isBetterRepresentative(candidate: Occurrence, current: Occurrence): boolean {
  if (candidate.item.lastVisitTime !== current.item.lastVisitTime) {
    return candidate.item.lastVisitTime > current.item.lastVisitTime;
  }
  if (candidate.item.visitCount !== current.item.visitCount) {
    return candidate.item.visitCount > current.item.visitCount;
  }
  const candidateDepth = candidate.identity.pathSegments.length;
  const currentDepth = current.identity.pathSegments.length;
  if (candidateDepth !== currentDepth) return candidateDepth > currentDepth;
  if (candidate.url.length !== current.url.length) return candidate.url.length < current.url.length;
  return candidate.url < current.url;
}

function fold(entry: WorkingEntry, occurrence: Occurrence, index: number): void {
  entry.visitCount += Math.max(0, occurrence.item.visitCount || 0);
  entry.days.add(startOfDay(occurrence.item.lastVisitTime || 0));
  entry.occurrences.push(occurrence.item);
  entry.displayTitle = betterTitle(entry.displayTitle, occurrence.item.title);
  entry.firstSeenIndex = Math.min(entry.firstSeenIndex, index);

  if (isBetterRepresentative(occurrence, entry.representative)) {
    entry.representative = occurrence;
    entry.identity = occurrence.identity;
  }
  if ((occurrence.item.lastVisitTime || 0) > entry.lastVisitedAt) {
    entry.lastVisitedAt = occurrence.item.lastVisitTime || 0;
  }
}

function toWorkingEntry(occurrence: Occurrence, index: number): WorkingEntry {
  return {
    identity: occurrence.identity,
    title: canonicalizeTitle(occurrence.item.title, occurrence.identity.siteIdentity),
    representative: occurrence,
    displayTitle: occurrence.item.title?.trim() || undefined,
    visitCount: Math.max(0, occurrence.item.visitCount || 0),
    lastVisitedAt: occurrence.item.lastVisitTime || 0,
    days: new Set([startOfDay(occurrence.item.lastVisitTime || 0)]),
    occurrences: [occurrence.item],
    firstSeenIndex: index,
  };
}

/** Re-derives the merged entry's comparison title from the title actually chosen to represent it. */
function refreshTitle(entry: WorkingEntry): void {
  entry.title = canonicalizeTitle(entry.displayTitle, entry.identity.siteIdentity);
}

/** Absorbs one whole logical page into another, once they've been judged duplicates. */
function mergeEntries(target: WorkingEntry, source: WorkingEntry): void {
  target.visitCount += source.visitCount;
  for (const day of source.days) target.days.add(day);
  target.occurrences.push(...source.occurrences);
  target.displayTitle = betterTitle(target.displayTitle, source.displayTitle);
  target.firstSeenIndex = Math.min(target.firstSeenIndex, source.firstSeenIndex);
  target.lastVisitedAt = Math.max(target.lastVisitedAt, source.lastVisitedAt);
  if (isBetterRepresentative(source.representative, target.representative)) {
    target.representative = source.representative;
    target.identity = source.identity;
  }
  refreshTitle(target);
}

/**
 * Folds already-filtered raw history items into canonical logical pages, in
 * two deterministic passes (see canonical.ts for the confidence tiers):
 *
 *  1. exact canonical identity — every URL that canonicalizes to the same
 *     key becomes one entry, no judgment involved;
 *  2. within a single site, entries that share a meaningful context path and
 *     an equivalent title are folded together too, in descending relevance
 *     order so the most recent/most-visited entry is the one that absorbs the
 *     rest rather than whichever happened to come first out of the browser.
 *
 * Entries on the same domain that do NOT share a context (Outlook's mail vs
 * calendar, Instagram's direct vs explore vs a profile) are never merged —
 * domain alone is explicitly not a duplicate signal.
 *
 * URL parsing/normalization reuses `parseSingleUrl` (the exact same parser
 * `parseUrls`/browser-import use) so there is exactly one notion of "what a
 * URL normalizes to" in this codebase. Items whose URL fails to parse are
 * dropped silently; `isNoiseUrl` should already have caught anything
 * unparseable, but this stays defensive rather than assuming that.
 */
export function aggregateHistoryEntries(items: HistoryVisitItem[]): AggregatedHistoryEntry[] {
  const byCanonicalKey = new Map<string, WorkingEntry>();

  items.forEach((item, index) => {
    const parsed = parseSingleUrl(item.url);
    if (!parsed) return;
    const identity = canonicalizeHistoryUrl(parsed.url);
    if (!identity) return;

    const occurrence: Occurrence = {
      item,
      url: item.url,
      normalizedUrl: parsed.normalizedUrl,
      domain: parsed.domain,
      identity,
    };

    const existing = byCanonicalKey.get(identity.key);
    if (existing) fold(existing, occurrence, index);
    else byCanonicalKey.set(identity.key, toWorkingEntry(occurrence, index));
  });

  for (const entry of byCanonicalKey.values()) refreshTitle(entry);

  const bySite = new Map<string, WorkingEntry[]>();
  for (const entry of byCanonicalKey.values()) {
    const bucket = bySite.get(entry.identity.siteIdentity);
    if (bucket) bucket.push(entry);
    else bySite.set(entry.identity.siteIdentity, [entry]);
  }

  const merged: WorkingEntry[] = [];
  for (const bucket of bySite.values()) {
    const ordered = [...bucket].sort(
      (a, b) =>
        b.lastVisitedAt - a.lastVisitedAt ||
        b.visitCount - a.visitCount ||
        a.identity.key.localeCompare(b.identity.key)
    );

    const accepted: WorkingEntry[] = [];
    for (const entry of ordered) {
      const target = accepted.find((group) => duplicateConfidence(group, entry) !== "none");
      if (target) mergeEntries(target, entry);
      else accepted.push(entry);
    }
    merged.push(...accepted);
  }

  return merged
    .sort((a, b) => a.firstSeenIndex - b.firstSeenIndex)
    .map((entry) => ({
      canonicalKey: entry.identity.key,
      url: entry.representative.url,
      normalizedUrl: entry.representative.normalizedUrl,
      domain: entry.representative.domain,
      title: entry.displayTitle,
      visitCount: entry.visitCount,
      lastVisitedAt: entry.lastVisitedAt,
      distinctDayCount: entry.days.size,
      occurrences: [...entry.occurrences].sort((a, b) => b.lastVisitTime - a.lastVisitTime),
      occurrenceCount: entry.occurrences.length,
    }));
}
