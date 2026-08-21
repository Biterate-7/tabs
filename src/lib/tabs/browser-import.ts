import { parseSingleUrl } from "./parse";
import { categorizeTabs } from "@/lib/categories";
import type { Tab } from "./types";

/**
 * Wire shape sent by the browser extension's content-script bridge. Kept
 * intentionally small: only fields the web app actually consumes today.
 * The extension's internal payload also carries `tabId`/`windowId`/`active`
 * for its own bookkeeping, but those are browser-session-specific and would
 * be meaningless once persisted as a `Tab`, so they're never forwarded here.
 */
export type BrowserImportEntry = {
  url: string;
  title?: string;
  pinned?: boolean;
};

/**
 * Converts extension-supplied tabs into `Tab`s using the exact same
 * URL parsing/normalization `parseUrls` uses for pasted text — no parallel
 * model. A browser-supplied title is kept as-is (it's already reliable),
 * which also means `useTitleResolution` will skip it: no redundant
 * `/api/titles` call for a title the browser already gave us for free.
 *
 * Deliberately does not de-duplicate or persist here — the caller decides
 * whether this is a fresh dump or a merge into an existing workspace, and
 * either way needs to run `markDuplicates` over the *combined* list, not
 * this batch alone.
 */
export function buildTabsFromBrowserImport(entries: BrowserImportEntry[]): Tab[] {
  const tabs: Tab[] = [];

  for (const entry of entries) {
    const tab = parseSingleUrl(entry.url);
    if (!tab) continue;

    const title = entry.title?.trim();
    tabs.push({
      ...tab,
      ...(title ? { title } : {}),
      ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
    });
  }

  return categorizeTabs(tabs);
}
