import { CATEGORIES } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";
import type { TabChunk } from "./types";

export type ExtractedForChunk = { description?: string; text?: string };

const MIN_BODY_CHARS = 200;

function categoryName(tab: Tab): string {
  const id = (tab.category as CategoryId | undefined) ?? "other";
  return CATEGORIES[id]?.name ?? "Other";
}

/**
 * Every tab always yields a "summary" chunk (title/domain/category/
 * description — cheap, always indexable even with no page content). A
 * "body" chunk is added on top when extracted page text is substantial
 * enough to be worth its own embedding rather than diluting the summary.
 */
export function buildChunks(tab: Tab, extracted?: ExtractedForChunk): TabChunk[] {
  const summaryParts = [
    tab.title?.trim() || tab.domain,
    `Domain: ${tab.domain}`,
    `Category: ${categoryName(tab)}`,
  ];
  if (extracted?.description) summaryParts.push(extracted.description);

  const chunks: TabChunk[] = [{ tabId: tab.id, kind: "summary", text: summaryParts.join("\n") }];

  if (extracted?.text && extracted.text.length >= MIN_BODY_CHARS) {
    chunks.push({ tabId: tab.id, kind: "body", text: extracted.text });
  }

  return chunks;
}

/**
 * Cheap FNV-1a hash of a tab's own fields — deliberately *not* extracted
 * page content, since that would require a network fetch just to check
 * whether a fetch is needed. The indexer compares this against what's
 * stored to decide whether a tab needs (re)fetching + (re)embedding at all;
 * once a tab's page content has been fetched, it's treated as stable until
 * the tab's own title/url/category changes.
 */
export function tabSignature(tab: Tab): string {
  const input = [tab.title ?? "", tab.url, tab.category ?? ""].join("|");

  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
