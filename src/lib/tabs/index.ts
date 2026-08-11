import { parseUrls } from "./parse";
import { markDuplicates } from "./duplicates";
import { categorizeTabs } from "@/lib/categories";
import type { ParseResult } from "./types";

export * from "./types";
export { parseUrls, splitInput } from "./parse";
export { normalizeUrl, TRACKING_PARAMS } from "./normalize";
export { markDuplicates } from "./duplicates";

export function parseTabInput(raw: string): ParseResult {
  const { tabs, invalidCount } = parseUrls(raw);
  const deduplicated = markDuplicates(tabs);
  return { tabs: categorizeTabs(deduplicated), invalidCount };
}
