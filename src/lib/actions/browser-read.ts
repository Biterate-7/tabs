import { asRecord, optionalInteger, optionalString } from "./validate";
import type { ActionDefinition } from "./types";
import type { BrowserTabInfo, BrowserWindowInfo } from "@/lib/browser/protocol";

const LIST_TABS_DEFAULT_LIMIT = 50;
const LIST_TABS_MAX_LIMIT = 200;

const NOT_CONNECTED_MESSAGE =
  "The TabDump browser extension isn't connected, so I can't see your open browser tabs right now.";

function matchesTabQuery(tab: BrowserTabInfo, query: string): boolean {
  const q = query.toLowerCase();
  return tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q);
}

type ListBrowserTabsData = { total: number; tabs: BrowserTabInfo[]; truncated: boolean };

export const listBrowserTabsAction: ActionDefinition<{ windowId?: number; query?: string; limit?: number }, ListBrowserTabsData> = {
  name: "list_browser_tabs",
  description:
    "List the user's actual, currently-open Chrome tabs (not their saved TabDump tabs) — title, URL, pinned/active state, window id. Requires the TabDump browser extension to be connected; if it isn't, this fails with a clear message rather than guessing. Use this before close_tab(s)/pin_tab/move_tabs_to_window to resolve which real browser tab(s) the user means.",
  readOnly: true,
  parameters: {
    type: "OBJECT",
    properties: {
      windowId: { type: "INTEGER", description: "Optional — limit to tabs in one browser window." },
      query: { type: "STRING", description: "Optional keyword filter over title/URL." },
      limit: { type: "INTEGER", description: `Max tabs to return (default ${LIST_TABS_DEFAULT_LIMIT}, capped at ${LIST_TABS_MAX_LIMIT}).` },
    },
    required: [],
  },
  validate(raw) {
    const record = asRecord(raw) ?? {};
    return {
      ok: true,
      args: {
        windowId: optionalInteger(record, "windowId"),
        query: optionalString(record, "query"),
        limit: optionalInteger(record, "limit"),
      },
    };
  },
  run(_store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };

    const limit = Math.min(Math.max(args.limit ?? LIST_TABS_DEFAULT_LIMIT, 1), LIST_TABS_MAX_LIMIT);
    let tabs = ctx.browserContext.tabs;
    if (args.windowId !== undefined) tabs = tabs.filter((t) => t.windowId === args.windowId);
    if (args.query) tabs = tabs.filter((t) => matchesTabQuery(t, args.query!));

    return { ok: true, data: { total: tabs.length, tabs: tabs.slice(0, limit), truncated: tabs.length > limit } };
  },
};

type GetActiveTabData = { tab: BrowserTabInfo | null };

export const getActiveTabAction: ActionDefinition<Record<string, never>, GetActiveTabData> = {
  name: "get_active_tab",
  description: "Get the user's currently active/focused browser tab. Requires the TabDump browser extension to be connected.",
  readOnly: true,
  parameters: { type: "OBJECT", properties: {}, required: [] },
  validate() {
    return { ok: true, args: {} };
  },
  run(_store, _args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    const tab = ctx.browserContext.tabs.find((t) => t.tabId === ctx.browserContext!.activeTabId) ?? null;
    return { ok: true, data: { tab } };
  },
};

type ListBrowserWindowsData = { windows: BrowserWindowInfo[] };

export const listBrowserWindowsAction: ActionDefinition<Record<string, never>, ListBrowserWindowsData> = {
  name: "list_browser_windows",
  description: "List the user's open browser windows and which tab ids belong to each. Requires the TabDump browser extension to be connected.",
  readOnly: true,
  parameters: { type: "OBJECT", properties: {}, required: [] },
  validate() {
    return { ok: true, args: {} };
  },
  run(_store, _args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    return { ok: true, data: { windows: ctx.browserContext.windows } };
  },
};
