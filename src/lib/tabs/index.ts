import { parseUrls } from "./parse";
import { markDuplicates } from "./duplicates";
import type { ParseResult } from "./types";

export * from "./types";
export { parseUrls, splitInput } from "./parse";
export { normalizeUrl, TRACKING_PARAMS } from "./normalize";
export { markDuplicates } from "./duplicates";

export function parseTabInput(raw: string): ParseResult {
  const { tabs, invalidCount } = parseUrls(raw);
  return { tabs: markDuplicates(tabs), invalidCount };
}
