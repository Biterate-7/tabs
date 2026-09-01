import { CATEGORIES } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import { sectionPath } from "@/lib/sections/relations";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";
import { groupByCategory } from "./stats";

export type SortKey = "recent" | "title" | "domain" | "category";

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other";
}

function categoryName(tab: Tab): string {
  return CATEGORIES[categoryOf(tab)].name;
}

/** Every section name in this tab's root→leaf path (e.g. "School" and "Physics" both match a tab filed under School → Physics) — see spec §23. Empty string for an unorganized tab. */
function sectionPathNames(tab: Tab, sections: Section[]): string {
  if (!tab.sectionId) return "";
  return sectionPath(sections, tab.sectionId)
    .map((s) => s.name)
    .join(" ");
}

export function matchesQuery(tab: Tab, query: string, sections: Section[] = []): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (tab.title ?? "").toLowerCase().includes(q) ||
    tab.domain.toLowerCase().includes(q) ||
    tab.url.toLowerCase().includes(q) ||
    categoryName(tab).toLowerCase().includes(q) ||
    sectionPathNames(tab, sections).toLowerCase().includes(q) ||
    (tab.notes ?? "").toLowerCase().includes(q)
  );
}

export function filterTabs(
  tabs: Tab[],
  opts: { query: string; categoryId: CategoryId | "all"; duplicatesOnly?: boolean; sections?: Section[] }
): Tab[] {
  return tabs.filter(
    (tab) =>
      matchesQuery(tab, opts.query, opts.sections) &&
      (opts.categoryId === "all" || categoryOf(tab) === opts.categoryId) &&
      (!opts.duplicatesOnly || Boolean(tab.isDuplicate))
  );
}

function titleOrDomain(tab: Tab): string {
  return (tab.title?.trim() || tab.domain).toLowerCase();
}

export function sortTabs(tabs: Tab[], sortKey: SortKey): Tab[] {
  if (sortKey === "recent") return tabs;

  const sorted = [...tabs];
  switch (sortKey) {
    case "title":
      sorted.sort((a, b) => titleOrDomain(a).localeCompare(titleOrDomain(b)));
      break;
    case "domain":
      sorted.sort((a, b) => a.domain.toLowerCase().localeCompare(b.domain.toLowerCase()));
      break;
    case "category":
      sorted.sort((a, b) => {
        const byName = categoryName(a).localeCompare(categoryName(b));
        return byName !== 0 ? byName : a.domain.localeCompare(b.domain);
      });
      break;
  }
  return sorted;
}

export function categoryCounts(tabs: Tab[]): Record<CategoryId, number> {
  const groups = groupByCategory(tabs);
  const counts = {} as Record<CategoryId, number>;
  for (const id of Object.keys(groups) as CategoryId[]) {
    counts[id] = groups[id].length;
  }
  return counts;
}
