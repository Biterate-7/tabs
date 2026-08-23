import { markDuplicates } from "@/lib/tabs";
import { buildTabsFromBrowserImport } from "@/lib/tabs/browser-import";
import { updateWorkspaceTabs } from "@/lib/workspace/store";
import { isSafeOpenUrl } from "@/lib/browser/protocol";
import {
  asRecord,
  optionalBoolean,
  optionalString,
  requiredInteger,
  requiredIntegerArray,
  requiredString,
} from "./validate";
import { findWorkspace } from "./lookup";
import type { ActionDefinition } from "./types";

const MAX_URLS_PER_CALL = 50;
const MAX_TAB_IDS_PER_CALL = 200;
const MAX_IMPORTED_TABS = 500;

const NOT_CONNECTED_MESSAGE =
  "The TabDump browser extension isn't connected, so I can't do anything with your actual browser tabs right now.";

function requiredUrl(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return isSafeOpenUrl(v) ? v : null;
}

function optionalUrlArray(record: Record<string, unknown>, key: string, max: number): string[] | undefined | null {
  const v = record[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every(isSafeOpenUrl) ? (v as string[]) : null;
}

function requiredUrlArray(record: Record<string, unknown>, key: string, max: number): string[] | null {
  const v = record[key];
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  return v.every(isSafeOpenUrl) ? (v as string[]) : null;
}

/**
 * These write actions never mutate WorkspaceStore (opening/closing/pinning a
 * real Chrome tab isn't a TabDump data change) — per AGENTS.md's
 * architectural constraint, this server-side run() can't touch chrome.*
 * either. So run() here only validates/resolves what the action needs;
 * store stays unchanged, and the CLIENT (src/lib/browser/execute.ts, called
 * from useAskTabDump once the server's response comes back) is what
 * actually talks to the extension. They still flow through the exact same
 * plan/preview/confirm pipeline as every other write action — see
 * BROWSER_ACTION_NAMES in plan.ts and planRequiresConfirmation's browser-
 * specific rules.
 */

export const openUrlAction: ActionDefinition<{ url: string }, { url: string }> = {
  name: "open_url",
  description: "Open one URL in a new browser tab. Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: { url: { type: "STRING", description: "Must be an http(s) URL." } },
    required: ["url"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `url` string." };
    const url = requiredUrl(record, "url");
    if (!url) return { ok: false, message: "`url` must be a non-empty http(s) URL." };
    return { ok: true, args: { url } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    return { ok: true, data: { url: args.url }, store };
  },
};

type OpenTabsData = { urlCount: number; urls: string[] };

export const openTabsAction: ActionDefinition<{ urls: string[]; newWindow?: boolean }, OpenTabsData> = {
  name: "open_tabs",
  description:
    "Open several URLs as new browser tabs in one call, e.g. urls found via search_tabs. Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      urls: { type: "ARRAY", items: { type: "STRING" }, description: `Up to ${MAX_URLS_PER_CALL} http(s) URLs to open.` },
      newWindow: { type: "BOOLEAN", description: "Open them in a brand-new browser window instead of the current one." },
    },
    required: ["urls"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `urls` array." };
    const urls = requiredUrlArray(record, "urls", MAX_URLS_PER_CALL);
    if (!urls) return { ok: false, message: `\`urls\` must be a non-empty array of up to ${MAX_URLS_PER_CALL} http(s) URLs.` };
    return { ok: true, args: { urls, newWindow: optionalBoolean(record, "newWindow") } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    return { ok: true, data: { urlCount: args.urls.length, urls: args.urls }, store };
  },
};

export const closeTabAction: ActionDefinition<{ tabId: number }, { tabId: number }> = {
  name: "close_tab",
  description: "Close one currently-open browser tab by its browser tab id (from list_browser_tabs/get_active_tab). Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: { tabId: { type: "INTEGER", description: "The browser's numeric tab id — not a TabDump saved-tab id." } },
    required: ["tabId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `tabId` integer." };
    const tabId = requiredInteger(record, "tabId");
    if (tabId === null) return { ok: false, message: "`tabId` is required and must be an integer." };
    return { ok: true, args: { tabId } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    if (!ctx.browserContext.tabs.some((t) => t.tabId === args.tabId)) {
      return { ok: false, message: `No open browser tab with id ${args.tabId} was found.` };
    }
    return { ok: true, data: { tabId: args.tabId }, store };
  },
};

type CloseTabsData = { tabIds: number[]; count: number };

export const closeTabsAction: ActionDefinition<{ tabIds: number[] }, CloseTabsData> = {
  name: "close_tabs",
  description:
    "Close several currently-open browser tabs by their browser tab ids in one call. Bulk closes always require the user's confirmation before anything is actually closed. Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      tabIds: { type: "ARRAY", items: { type: "INTEGER" }, description: `Up to ${MAX_TAB_IDS_PER_CALL} browser tab ids.` },
    },
    required: ["tabIds"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `tabIds` array." };
    const tabIds = requiredIntegerArray(record, "tabIds", MAX_TAB_IDS_PER_CALL);
    if (!tabIds) return { ok: false, message: `\`tabIds\` must be a non-empty array of up to ${MAX_TAB_IDS_PER_CALL} integers.` };
    return { ok: true, args: { tabIds } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    const openIds = new Set(ctx.browserContext.tabs.map((t) => t.tabId));
    const found = args.tabIds.filter((id) => openIds.has(id));
    if (found.length === 0) return { ok: false, message: "None of the given browser tab ids are currently open." };
    return { ok: true, data: { tabIds: found, count: found.length }, store };
  },
};

function pinAction(name: "pin_tab" | "unpin_tab", pinned: boolean): ActionDefinition<{ tabId: number }, { tabId: number; pinned: boolean }> {
  return {
    name,
    description: `${pinned ? "Pin" : "Unpin"} one currently-open browser tab by its browser tab id. Requires the TabDump browser extension to be connected.`,
    readOnly: false,
    parameters: {
      type: "OBJECT",
      properties: { tabId: { type: "INTEGER", description: "The browser's numeric tab id — not a TabDump saved-tab id." } },
      required: ["tabId"],
    },
    validate(raw) {
      const record = asRecord(raw);
      if (!record) return { ok: false, message: "Expected an object with a `tabId` integer." };
      const tabId = requiredInteger(record, "tabId");
      if (tabId === null) return { ok: false, message: "`tabId` is required and must be an integer." };
      return { ok: true, args: { tabId } };
    },
    run(store, args, ctx) {
      if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
      if (!ctx.browserContext.tabs.some((t) => t.tabId === args.tabId)) {
        return { ok: false, message: `No open browser tab with id ${args.tabId} was found.` };
      }
      return { ok: true, data: { tabId: args.tabId, pinned }, store };
    },
  };
}

export const pinTabAction = pinAction("pin_tab", true);
export const unpinTabAction = pinAction("unpin_tab", false);

type MoveTabsToWindowData = { tabIds: number[]; windowId: number };

export const moveTabsToWindowAction: ActionDefinition<{ tabIds: number[]; windowId: number }, MoveTabsToWindowData> = {
  name: "move_tabs_to_window",
  description: "Move browser tabs into an existing browser window by id (from list_browser_windows). Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      tabIds: { type: "ARRAY", items: { type: "INTEGER" }, description: `Up to ${MAX_TAB_IDS_PER_CALL} browser tab ids.` },
      windowId: { type: "INTEGER", description: "The destination browser window's id." },
    },
    required: ["tabIds", "windowId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with `tabIds` and `windowId`." };
    const tabIds = requiredIntegerArray(record, "tabIds", MAX_TAB_IDS_PER_CALL);
    const windowId = requiredInteger(record, "windowId");
    if (!tabIds) return { ok: false, message: `\`tabIds\` must be a non-empty array of up to ${MAX_TAB_IDS_PER_CALL} integers.` };
    if (windowId === null) return { ok: false, message: "`windowId` is required and must be an integer." };
    return { ok: true, args: { tabIds, windowId } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    if (!ctx.browserContext.windows.some((w) => w.windowId === args.windowId)) {
      return { ok: false, message: `No open browser window with id ${args.windowId} was found.` };
    }
    return { ok: true, data: args, store };
  },
};

type CreateBrowserWindowData = { urls: string[]; focused: boolean };

export const createBrowserWindowAction: ActionDefinition<{ urls?: string[]; focused?: boolean }, CreateBrowserWindowData> = {
  name: "create_browser_window",
  description: "Create a brand-new browser window, optionally opening some URLs in it. Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: {
      urls: { type: "ARRAY", items: { type: "STRING" }, description: `Optional — up to ${MAX_URLS_PER_CALL} http(s) URLs to open in the new window.` },
      focused: { type: "BOOLEAN", description: "Whether the new window should become focused (default true)." },
    },
    required: [],
  },
  validate(raw) {
    const record = asRecord(raw) ?? {};
    const urls = optionalUrlArray(record, "urls", MAX_URLS_PER_CALL);
    if (urls === null) return { ok: false, message: `\`urls\`, if given, must be an array of up to ${MAX_URLS_PER_CALL} http(s) URLs.` };
    return { ok: true, args: { urls, focused: optionalBoolean(record, "focused") } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    return { ok: true, data: { urls: args.urls ?? [], focused: args.focused ?? true }, store };
  },
};

type OpenWorkspaceData = { workspaceId: string; workspaceName: string; urls: string[]; tabCount: number; truncated: boolean };

export const openWorkspaceInBrowserAction: ActionDefinition<{ workspaceId: string }, OpenWorkspaceData> = {
  name: "open_workspace_in_browser",
  description:
    "Open every saved tab in one TabDump workspace as real browser tabs. Resolve the workspace id first with list_workspaces if the user only gave a name. Requires the TabDump browser extension to be connected.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: { workspaceId: { type: "STRING" } },
    required: ["workspaceId"],
  },
  validate(raw) {
    const record = asRecord(raw);
    if (!record) return { ok: false, message: "Expected an object with a `workspaceId` string." };
    const workspaceId = requiredString(record, "workspaceId");
    if (!workspaceId) return { ok: false, message: "`workspaceId` is required and must be a non-empty string." };
    return { ok: true, args: { workspaceId } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };
    const workspace = findWorkspace(store, args.workspaceId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${args.workspaceId}".` };

    const allUrls = workspace.tabs.map((t) => t.url);
    const urls = allUrls.slice(0, MAX_URLS_PER_CALL);
    if (urls.length === 0) return { ok: false, message: `Workspace "${workspace.name}" has no tabs to open.` };

    return {
      ok: true,
      data: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        urls,
        tabCount: urls.length,
        truncated: allUrls.length > urls.length,
      },
      store,
    };
  },
};

type ImportBrowserTabsData = { workspaceId: string; workspaceName: string; importedCount: number };

export const importBrowserTabsToWorkspaceAction: ActionDefinition<{ workspaceId?: string }, ImportBrowserTabsData> = {
  name: "import_browser_tabs_to_workspace",
  description:
    "Save the user's currently-open real browser tabs into a TabDump workspace (defaults to the current workspace if none is given) — e.g. \"save my current browser tabs to my Physics workspace.\" Requires the TabDump browser extension to be connected. Unlike other browser actions, this one directly updates TabDump data (like move_tabs does), not the live browser.",
  readOnly: false,
  parameters: {
    type: "OBJECT",
    properties: { workspaceId: { type: "STRING", description: "Optional — defaults to the current workspace." } },
    required: [],
  },
  validate(raw) {
    const record = asRecord(raw) ?? {};
    return { ok: true, args: { workspaceId: optionalString(record, "workspaceId") } };
  },
  run(store, args, ctx) {
    if (!ctx?.browserContext) return { ok: false, message: NOT_CONNECTED_MESSAGE };

    const targetId = args.workspaceId ?? store.currentId;
    const workspace = findWorkspace(store, targetId);
    if (!workspace) return { ok: false, message: `No workspace found with id "${targetId}".` };

    const entries = ctx.browserContext.tabs
      .slice(0, MAX_IMPORTED_TABS)
      .map((t) => ({ url: t.url, title: t.title, pinned: t.pinned, favicon: t.favIconUrl }));
    const incoming = buildTabsFromBrowserImport(entries);
    if (incoming.length === 0) return { ok: false, message: "None of the currently-open browser tabs could be saved." };

    const merged = markDuplicates([...workspace.tabs, ...incoming]);
    const nextStore = updateWorkspaceTabs(store, workspace.id, merged);

    return {
      ok: true,
      data: { workspaceId: workspace.id, workspaceName: workspace.name, importedCount: incoming.length },
      store: nextStore,
    };
  },
};
