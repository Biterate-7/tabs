import { CATEGORY_ORDER } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";

export type WorkspaceOverview = {
  total: number;
  unique: number;
  categoriesInUse: number;
  duplicates: number;
};

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other";
}

export function computeOverview(tabs: Tab[]): WorkspaceOverview {
  const duplicates = tabs.filter((t) => t.isDuplicate).length;
  const used = new Set(tabs.map(categoryOf));
  return {
    total: tabs.length,
    unique: tabs.length - duplicates,
    categoriesInUse: used.size,
    duplicates,
  };
}

export function groupByCategory(tabs: Tab[]): Record<CategoryId, Tab[]> {
  const groups = {} as Record<CategoryId, Tab[]>;
  for (const id of CATEGORY_ORDER) groups[id] = [];
  for (const tab of tabs) groups[categoryOf(tab)].push(tab);
  return groups;
}

/**
 * Picks up to `limit` representative tabs (one per distinct domain,
 * non-duplicates preferred) and returns their display label: the
 * resolved title when available, falling back to the domain.
 */
export function representativeTabLabels(tabs: Tab[], limit = 3): string[] {
  const ordered = [...tabs].sort(
    (a, b) => Number(!!a.isDuplicate) - Number(!!b.isDuplicate)
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tab of ordered) {
    if (seen.has(tab.domain)) continue;
    seen.add(tab.domain);
    result.push(tab.title?.trim() || tab.domain);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Same selection as `representativeTabLabels` (one per distinct domain,
 * non-duplicates preferred) but returns the tabs themselves — used by the
 * folder-preview UI, which needs each tab's favicon/title, not just a label.
 */
export function representativeTabs(tabs: Tab[], limit = 3): Tab[] {
  const ordered = [...tabs].sort(
    (a, b) => Number(!!a.isDuplicate) - Number(!!b.isDuplicate)
  );
  const seen = new Set<string>();
  const result: Tab[] = [];
  for (const tab of ordered) {
    if (seen.has(tab.domain)) continue;
    seen.add(tab.domain);
    result.push(tab);
    if (result.length >= limit) break;
  }
  return result;
}
