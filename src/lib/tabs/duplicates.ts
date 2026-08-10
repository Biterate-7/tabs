import type { Tab } from "./types";

export function markDuplicates(tabs: Tab[]): Tab[] {
  const seen = new Set<string>();
  return tabs.map((tab) => {
    const isDuplicate = seen.has(tab.normalizedUrl);
    seen.add(tab.normalizedUrl);
    return { ...tab, isDuplicate };
  });
}
