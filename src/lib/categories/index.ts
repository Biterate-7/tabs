import { classifyUrl } from "./classify";
import type { Tab } from "@/lib/tabs/types";

export * from "./types";
export { CATEGORIES, CATEGORY_ORDER } from "./definitions";
export { classifyUrl, scoreUrl } from "./classify";

export function categorizeTabs(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => {
    const { category, confidence } = classifyUrl(tab.normalizedUrl);
    return { ...tab, category, confidence };
  });
}
