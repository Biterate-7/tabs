import { isSafeOpenUrl } from "@/lib/browser/protocol";
import { normalizeUrl } from "@/lib/tabs/normalize";
import { resourceKey } from "@/lib/resources/url";
import { subjectName } from "@/lib/product/subjects";
import type { BrowserTabInfo } from "@/lib/browser/protocol";
import type { Collection } from "@/lib/collections/types";
import type { Workspace } from "@/lib/workspace/types";
import type { SmartItem } from "./types";

/**
 * How many tabs one Smart Organize pass looks at. Grouping is quadratic in
 * this, and a review screen with more rows than this is no longer a review —
 * past it, the rest are reported as left out rather than silently dropped.
 */
export const MAX_SMART_ITEMS = 300;

type Address = { url: string; normalizedUrl: string; resourceKey: string; domain: string };

/** The parts of an address Smart Organize compares, or null for anything that is not an openable web page. */
export function describeAddress(raw: string): Address | null {
  const url = raw.trim();
  if (!isSafeOpenUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A bare intranet name or localhost is not something a subject should hold (lib/tabs/parse.ts has the same rule).
  if (!parsed.hostname.includes(".")) return null;
  const key = resourceKey(url);
  if (!key) return null;
  return { url, normalizedUrl: normalizeUrl(parsed), resourceKey: key, domain: parsed.hostname.toLowerCase().replace(/^www\./, "") };
}

/** Chrome shows the address as the title of a page that has none; that is not a title. */
function cleanTitle(title: string | undefined, url: string): string {
  const trimmed = (title ?? "").trim();
  if (!trimmed || trimmed === url || /^https?:\/\//i.test(trimmed)) return "";
  return trimmed;
}

/**
 * Where each address is already saved, first subject wins — as a source or as
 * a plain saved tab. Either way the page is already the person's, somewhere:
 * left in, it would be saved a second time in another subject.
 */
function savedPages(workspaces: readonly Workspace[]): Map<string, { workspaceId: string; name: string }> {
  const saved = new Map<string, { workspaceId: string; name: string }>();
  for (const workspace of workspaces) {
    for (const tab of workspace.tabs) {
      const key = resourceKey(tab.url);
      if (key && !saved.has(key)) saved.set(key, { workspaceId: workspace.id, name: subjectName(workspace) });
    }
  }
  return saved;
}

export type BrowserItems = {
  items: SmartItem[];
  /** Open tabs that are not web pages Hubble can save: new tabs, chrome:// pages, files, Hubble itself. */
  skipped: number;
  /** Tabs in private (incognito) windows — or in a window not known to be ordinary — never looked at. */
  privateSkipped: number;
  truncated: number;
};

/**
 * The open Chrome tabs Smart Organize may look at: web pages only, never
 * Hubble's own tabs, never a tab in a private window, each Chrome tab once.
 * A page already saved somewhere is marked so the proposal can leave it out by
 * default instead of saving a second copy.
 */
export function itemsFromBrowserTabs(
  tabs: readonly BrowserTabInfo[],
  workspaces: readonly Workspace[],
  /**
   * `normalWindowIds`: the windows known to be ordinary (not incognito). When
   * given, a tab is read only if its window is one of them — a window opened
   * between Chrome's two answers, or one Chrome did not describe, counts as
   * private. The open-tabs dialog always passes it.
   */
  options: { selfOrigin?: string; normalWindowIds?: ReadonlySet<number> } = {}
): BrowserItems {
  const saved = savedPages(workspaces);
  const seenTabIds = new Set<number>();
  const items: SmartItem[] = [];
  let skipped = 0;
  let privateSkipped = 0;
  let truncated = 0;

  for (const tab of tabs) {
    if (seenTabIds.has(tab.tabId)) continue;
    seenTabIds.add(tab.tabId);
    if (options.normalWindowIds && !options.normalWindowIds.has(tab.windowId)) {
      privateSkipped += 1;
      continue;
    }
    const address = describeAddress(tab.url ?? "");
    if (!address || (options.selfOrigin && address.url.startsWith(options.selfOrigin))) {
      skipped += 1;
      continue;
    }
    if (items.length >= MAX_SMART_ITEMS) {
      truncated += 1;
      continue;
    }
    const savedIn = saved.get(address.resourceKey);
    items.push({
      id: `chrome-${tab.tabId}`,
      ...address,
      title: cleanTitle(tab.title, address.url),
      ...(tab.favIconUrl ? { favicon: tab.favIconUrl } : {}),
      ...(savedIn ? { savedIn } : {}),
    });
  }
  return { items, skipped, privateSkipped, truncated };
}

/** The ids of ordinary (not incognito) windows, from list_browser_windows. */
export function normalWindowIds(windows: readonly { windowId: number; incognito: boolean }[]): Set<number> {
  return new Set(windows.filter((window) => window.incognito === false).map((window) => window.windowId));
}

/**
 * A subject's saved tabs, as Smart Organize sees them. A tab already in one
 * of the subject's collections is marked: someone put it there, and the
 * proposal leaves it alone by default.
 */
export function itemsFromSubject(workspace: Workspace, collections: readonly Collection[]): { items: SmartItem[]; truncated: number } {
  const holder = new Map<string, { collectionId: string; name: string }>();
  for (const collection of collections) {
    if (collection.workspaceId !== workspace.id) continue;
    for (const tabId of collection.tabIds) if (!holder.has(tabId)) holder.set(tabId, { collectionId: collection.id, name: collection.name });
  }

  const items: SmartItem[] = [];
  let truncated = 0;
  for (const tab of workspace.tabs) {
    const address = describeAddress(tab.url);
    if (!address) continue;
    if (items.length >= MAX_SMART_ITEMS) {
      truncated += 1;
      continue;
    }
    const inCollection = holder.get(tab.id);
    items.push({
      id: tab.id,
      ...address,
      // The saved record is the authority for these two: it is what the subject shows.
      normalizedUrl: tab.normalizedUrl || address.normalizedUrl,
      domain: tab.domain || address.domain,
      title: cleanTitle(tab.title, tab.url),
      ...(tab.favicon ? { favicon: tab.favicon } : {}),
      ...(inCollection ? { inCollection } : {}),
    });
  }
  return { items, truncated };
}
