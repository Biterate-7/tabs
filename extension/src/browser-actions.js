// The only file in this extension that both (a) touches chrome.tabs /
// chrome.windows and (b) executes AI-originated commands — every function
// here assumes its `args` already passed validateBrowserCommand() in
// browser-commands.js and never re-derives trust from anything else.
//
// Every handler is deliberately narrow: it does exactly the one Chrome API
// call(s) its name promises, nothing more (no arbitrary script injection,
// no reading page content). See AGENTS.md's Chrome Browser Control spec,
// section 2/14.

import { findMatchingTab } from "./tab-matching.js";

function toTabSummary(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? "",
    title: tab.title ?? "",
    favIconUrl: tab.favIconUrl,
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    index: tab.index,
  };
}

function toWindowSummary(win) {
  return {
    windowId: win.id,
    focused: Boolean(win.focused),
    incognito: Boolean(win.incognito),
    type: win.type,
    tabIds: (win.tabs ?? []).map((t) => t.id),
  };
}

export async function listBrowserTabs(args) {
  const query = args.windowId === undefined ? {} : { windowId: args.windowId };
  const tabs = await chrome.tabs.query(query);
  return { tabs: tabs.map(toTabSummary) };
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { tab: tab ? toTabSummary(tab) : null };
}

export async function listBrowserWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  return { windows: windows.map(toWindowSummary) };
}

/**
 * Looks for a tab already showing `url` (see tab-matching.js for the
 * matching rules — normalized, not exact-string) so openUrl can activate it
 * instead of creating a duplicate. A failed lookup is treated the same as
 * "not found": openUrl falls through to its normal create-a-new-tab
 * behavior rather than failing the whole command over a lookup that isn't
 * essential to it.
 */
async function findExistingOpenTab(url) {
  try {
    const tabs = await chrome.tabs.query({});
    return findMatchingTab(tabs, url);
  } catch {
    return undefined;
  }
}

export async function openUrl(args) {
  const existing = await findExistingOpenTab(args.url);
  if (existing) {
    const updated = await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return { tab: toTabSummary(updated ?? existing), alreadyOpen: true };
  }

  const tab = await chrome.tabs.create({ url: args.url, active: args.active });
  return { tab: toTabSummary(tab), alreadyOpen: false };
}

/**
 * Opens every url independently and keeps going even if one fails (a
 * blocked/unreachable url shouldn't sink the rest of the batch) — the
 * caller reports "opened N of M" rather than an all-or-nothing failure, per
 * AGENTS.md section 15.
 */
export async function openTabs(args) {
  const opened = [];
  const failed = [];
  let windowId;
  let remaining = args.urls;

  if (args.newWindow) {
    try {
      const win = await chrome.windows.create({ url: args.urls[0], focused: true });
      windowId = win.id;
      const firstTab = win.tabs?.[0];
      if (firstTab) opened.push(toTabSummary(firstTab));
      remaining = args.urls.slice(1);
    } catch (err) {
      failed.push({ url: args.urls[0], error: err instanceof Error ? err.message : "Failed to open." });
      remaining = args.urls.slice(1);
    }
  }

  for (const url of remaining) {
    try {
      const tab = await chrome.tabs.create({ url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
      opened.push(toTabSummary(tab));
    } catch (err) {
      failed.push({ url, error: err instanceof Error ? err.message : "Failed to open." });
    }
  }

  return { opened, failed };
}

export async function closeTab(args) {
  await chrome.tabs.get(args.tabId); // throws if the tab no longer exists
  await chrome.tabs.remove(args.tabId);
  return { closed: true, tabId: args.tabId };
}

export async function closeTabs(args) {
  const closed = [];
  const failed = [];
  for (const tabId of args.tabIds) {
    try {
      await chrome.tabs.get(tabId);
      await chrome.tabs.remove(tabId);
      closed.push(tabId);
    } catch (err) {
      failed.push({ tabId, error: err instanceof Error ? err.message : "Tab not found." });
    }
  }
  return { closed, failed };
}

async function setPinned(tabId, pinned) {
  const before = await chrome.tabs.get(tabId);
  const previousPinned = Boolean(before.pinned);
  if (previousPinned === pinned) return { tabId, pinned, previousPinned };
  await chrome.tabs.update(tabId, { pinned });
  return { tabId, pinned, previousPinned };
}

export async function pinTab(args) {
  return setPinned(args.tabId, args.pinned);
}

export async function unpinTab(args) {
  return setPinned(args.tabId, args.pinned);
}

export async function moveTabsToWindow(args) {
  const moved = await chrome.tabs.move(args.tabIds, { windowId: args.windowId, index: -1 });
  const movedTabs = Array.isArray(moved) ? moved : [moved];
  return { moved: movedTabs.map(toTabSummary) };
}

export async function createBrowserWindow(args) {
  const win = await chrome.windows.create({
    url: args.urls.length > 0 ? args.urls : undefined,
    focused: args.focused,
  });
  return { window: toWindowSummary(win) };
}

export const BROWSER_ACTION_HANDLERS = {
  list_browser_tabs: listBrowserTabs,
  get_active_tab: getActiveTab,
  list_browser_windows: listBrowserWindows,
  open_url: openUrl,
  open_tabs: openTabs,
  close_tab: closeTab,
  close_tabs: closeTabs,
  pin_tab: pinTab,
  unpin_tab: unpinTab,
  move_tabs_to_window: moveTabsToWindow,
  create_browser_window: createBrowserWindow,
};
