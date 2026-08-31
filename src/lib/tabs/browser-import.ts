import { parseSingleUrl } from "./parse";
import { categorizeTabs } from "@/lib/categories";
import { isGoogleDocsHostname, stripGoogleDocsSuffix } from "@/lib/titles/google-docs-host";
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
  /** From chrome.tabs.Tab.favIconUrl, when the caller has it (see src/lib/actions/browser-write.ts's import_browser_tabs_to_workspace) — the original popup-based dump flow doesn't collect this today, so it's commonly absent. */
  favicon?: string;
  /** Set only by History Dump (src/lib/history-dump/) to "history" for a candidate the user selected — omitted entirely (not just "tabs") by the ordinary open-tabs dump flow, since that's still the overwhelmingly common path and every existing Tab predates this field. */
  source?: "tabs" | "history";
  /** History Dump's point-in-time visit count/last-visit snapshot for this entry — see Tab.historyVisitCount/historyLastVisitedAt. Only meaningful (and only ever set) alongside `source: "history"`. */
  historyVisitCount?: number;
  historyLastVisitedAt?: number;
};

/**
 * Converts extension-supplied tabs into `Tab`s using the exact same
 * URL parsing/normalization `parseUrls` uses for pasted text — no parallel
 * model. A browser-supplied title is kept as-is (it's already reliable),
 * which also means `useTitleResolution` will skip it: no redundant
 * `/api/titles` call for a title the browser already gave us for free.
 *
 * The one exception: `chrome.tabs.Tab.title` for a Google Docs/Sheets/Slides
 * tab carries the browser's own "Document Name - Google Docs" suffix, which
 * the server-side resolver already strips for pasted URLs (see
 * server/resolvers/google-docs.ts) — stripping it here too keeps a tab's
 * displayed name consistent regardless of which path it arrived through.
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

    const trimmedTitle = entry.title?.trim();
    const title =
      trimmedTitle && isGoogleDocsHostname(tab.domain) ? stripGoogleDocsSuffix(trimmedTitle) : trimmedTitle;
    tabs.push({
      ...tab,
      ...(title ? { title } : {}),
      ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
      ...(entry.favicon ? { favicon: entry.favicon } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.historyVisitCount !== undefined ? { historyVisitCount: entry.historyVisitCount } : {}),
      ...(entry.historyLastVisitedAt !== undefined ? { historyLastVisitedAt: entry.historyLastVisitedAt } : {}),
    });
  }

  return categorizeTabs(tabs);
}
