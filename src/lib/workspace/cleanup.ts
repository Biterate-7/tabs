import { markDuplicates } from "@/lib/tabs";
import type { Tab } from "@/lib/tabs/types";

/** Matches Phase 3's MIN_CONFIDENT_SCORE (40) / MAX_SCORE (100). */
export const NEEDS_REVIEW_CONFIDENCE = 0.4;

export type DuplicateGroup = {
  key: string;
  domain: string;
  title?: string;
  tabs: Tab[];
  count: number;
};

export type CleanupSummary = {
  total: number;
  unique: number;
  duplicates: number;
  needsReview: number;
  groupCount: number;
};

export type CleanupSelection = {
  keepIds: Record<string, string>;
  skippedKeys: string[];
};

export function findDuplicateGroups(tabs: Tab[]): DuplicateGroup[] {
  const buckets = new Map<string, Tab[]>();
  for (const tab of tabs) {
    const bucket = buckets.get(tab.normalizedUrl);
    if (bucket) bucket.push(tab);
    else buckets.set(tab.normalizedUrl, [tab]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, groupTabs] of buckets) {
    if (groupTabs.length < 2) continue;
    groups.push({
      key,
      domain: groupTabs[0].domain,
      title: groupTabs.find((t) => t.title?.trim())?.title,
      tabs: groupTabs,
      count: groupTabs.length,
    });
  }
  return groups;
}

export function computeCleanupSummary(tabs: Tab[]): CleanupSummary {
  const duplicates = tabs.filter((t) => t.isDuplicate).length;
  const needsReview = tabs.filter(
    (t) => (t.confidence ?? 0) < NEEDS_REVIEW_CONFIDENCE
  ).length;
  return {
    total: tabs.length,
    unique: tabs.length - duplicates,
    duplicates,
    needsReview,
    groupCount: findDuplicateGroups(tabs).length,
  };
}

export function defaultSelection(groups: DuplicateGroup[]): CleanupSelection {
  const keepIds: Record<string, string> = {};
  for (const group of groups) keepIds[group.key] = group.tabs[0].id;
  return { keepIds, skippedKeys: [] };
}

export function removalIds(
  groups: DuplicateGroup[],
  selection: CleanupSelection
): string[] {
  const skipped = new Set(selection.skippedKeys);
  const ids: string[] = [];
  for (const group of groups) {
    if (skipped.has(group.key)) continue;
    const keepId = selection.keepIds[group.key] ?? group.tabs[0].id;
    for (const tab of group.tabs) {
      if (tab.id !== keepId) ids.push(tab.id);
    }
  }
  return ids;
}

export function removeTabs(tabs: Tab[], ids: string[]): Tab[] {
  if (ids.length === 0) return tabs;
  const removing = new Set(ids);
  return markDuplicates(tabs.filter((t) => !removing.has(t.id)));
}
