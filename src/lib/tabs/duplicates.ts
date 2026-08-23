import type { Tab } from "./types";

export function markDuplicates(tabs: Tab[]): Tab[] {
  const seen = new Set<string>();
  return tabs.map((tab) => {
    const isDuplicate = seen.has(tab.normalizedUrl);
    seen.add(tab.normalizedUrl);
    return { ...tab, isDuplicate };
  });
}

export type DuplicateConfidence = "high" | "medium";

/**
 * One group of items sharing a URL, generic over whatever id type the
 * caller's items use (TabDump tab ids are strings; browser tab ids are
 * numbers — see find_duplicates in src/lib/actions/duplicates.ts, the only
 * consumer that needs both). `duplicateGroupId` is stable only within one
 * call's output, not persisted anywhere.
 */
export type DuplicateGroup<Id> = {
  duplicateGroupId: string;
  ids: Id[];
  reason: string;
  confidence: DuplicateConfidence;
};

/**
 * Collapses a normalized URL down further for a looser "probably the same
 * page" equivalence class: strips the `www.` prefix and the protocol, since
 * `http://example.com/x` and `https://www.example.com/x` are, in practice,
 * almost always the same page saved twice. Deliberately NOT folded into
 * normalizeUrl()/markDuplicates() itself — those stay a strict, high-
 * confidence notion of "identical," which is what duplicate-flagging on
 * save (isDuplicate) and Auto-Organize's duplicate detection both rely on.
 * This is a second, explicitly lower-confidence tier only find_duplicates
 * uses.
 */
function canonicalizeUrl(normalizedUrl: string): string {
  try {
    const parsed = new URL(normalizedUrl);
    const host = parsed.hostname.replace(/^www\./, "");
    return `${host}${parsed.pathname}${parsed.search}`;
  } catch {
    return normalizedUrl;
  }
}

/**
 * First-class duplicate detection (Step 4): groups `items` (any URL-bearing
 * collection — saved tabs, or a live browser tab list) into duplicate sets
 * at two confidence tiers, never mutating or deleting anything itself. A
 * "high" confidence group shares the exact same normalizedUrl (tracking
 * params already stripped upstream — see normalizeUrl). A "medium"
 * confidence group only shares a canonicalized URL (www/protocol variant) —
 * computed from whatever's left AFTER high-confidence groups are pulled out,
 * so no item is ever double-counted across both tiers.
 */
export function findDuplicateGroups<Id>(
  items: { id: Id; normalizedUrl: string; domain: string }[]
): DuplicateGroup<Id>[] {
  const byExact = new Map<string, typeof items>();
  for (const item of items) {
    const bucket = byExact.get(item.normalizedUrl);
    if (bucket) bucket.push(item);
    else byExact.set(item.normalizedUrl, [item]);
  }

  const groups: DuplicateGroup<Id>[] = [];
  const groupedIds = new Set<Id>();
  let counter = 0;

  for (const bucket of byExact.values()) {
    if (bucket.length < 2) continue;
    groups.push({
      duplicateGroupId: `dup-${counter++}`,
      ids: bucket.map((item) => item.id),
      reason: `${bucket.length} copies of the same page (${bucket[0].domain}).`,
      confidence: "high",
    });
    for (const item of bucket) groupedIds.add(item.id);
  }

  const remaining = items.filter((item) => !groupedIds.has(item.id));
  const byCanonical = new Map<string, typeof items>();
  for (const item of remaining) {
    const key = canonicalizeUrl(item.normalizedUrl);
    const bucket = byCanonical.get(key);
    if (bucket) bucket.push(item);
    else byCanonical.set(key, [item]);
  }

  for (const bucket of byCanonical.values()) {
    if (bucket.length < 2) continue;
    groups.push({
      duplicateGroupId: `dup-${counter++}`,
      ids: bucket.map((item) => item.id),
      reason: `${bucket.length} likely copies of the same page, saved slightly differently (${bucket[0].domain}).`,
      confidence: "medium",
    });
  }

  return groups;
}
