/**
 * The typed command protocol between this web app and the Hubble Chrome
 * extension (see extension/src/browser-commands.js for the extension's own
 * copy of the allowlist/validators this must match). Message constants are
 * duplicated here rather than imported — the extension's content script is
 * plain JS with no build step, and the same "keep these in sync" tradeoff
 * already exists between extension/src/config.js and
 * extension/content/content-script.js.
 */
export const BROWSER_MESSAGE_SOURCE = "tabdump-extension";
export const MSG_BROWSER_COMMAND = "TABDUMP_BROWSER_COMMAND";
export const MSG_BROWSER_COMMAND_RESULT = "TABDUMP_BROWSER_COMMAND_RESULT";
export const MSG_EXTENSION_PING = "TABDUMP_EXTENSION_PING";
export const MSG_EXTENSION_PONG = "TABDUMP_EXTENSION_PONG";

/**
 * The tab-dump import handshake (see src/hooks/use-extension-import.ts here,
 * extension/content/content-script.js and extension/src/config.js there).
 *
 * TABDUMP_IMPORT carries the batch plus an `importId`; the page answers
 * TABDUMP_IMPORT_ACK with that same id and the number of tabs it accepted,
 * and announces TABDUMP_PAGE_READY as soon as it is able to ingest at all.
 * The ack is what lets the extension distinguish "handed the message to a
 * content script" from "the app actually took these tabs" — without it, a
 * batch delivered while the page was still hydrating was dropped silently
 * and still reported as a successful dump.
 */
export const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
export const MSG_TABDUMP_IMPORT_ACK = "TABDUMP_IMPORT_ACK";
export const MSG_TABDUMP_PAGE_READY = "TABDUMP_PAGE_READY";

/** Default time to wait for a browser command's result before giving up — see sendBrowserCommand. */
export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 8000;

/**
 * The allowlist extension/src/browser-commands.js implements. Only three of
 * these are actually sent from this web app today — list_browser_tabs/
 * list_browser_windows (src/lib/browser/context.ts, for title resolution)
 * and open_url (src/lib/browser/open-tab.ts, for opening a saved tab). The
 * rest (get_active_tab, open_tabs, close_tab, close_tabs, pin_tab,
 * unpin_tab, move_tabs_to_window, create_browser_window) were only ever
 * invoked by Ask Hubble's chat-driven browser-control actions, which have
 * been removed — the extension still implements handlers for them, but
 * nothing here calls them anymore. `get_history` is the exception to that
 * "three actions" count: it backs History Dump (src/lib/browser/history.ts).
 */
export type BrowserActionName =
  | "list_browser_tabs"
  | "get_active_tab"
  | "list_browser_windows"
  | "get_history"
  | "open_url"
  | "open_tabs"
  | "close_tab"
  | "close_tabs"
  | "pin_tab"
  | "unpin_tab"
  | "move_tabs_to_window"
  | "create_browser_window";

export type BrowserCommand<Args = unknown> = {
  id: string;
  action: BrowserActionName;
  args: Args;
};

export type BrowserCommandResult<Data = unknown> =
  | { id: string; ok: true; result: Data }
  | { id: string; ok: false; error: string };

export type BrowserTabInfo = {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  favIconUrl?: string;
  pinned: boolean;
  active: boolean;
  index: number;
};

export type BrowserWindowInfo = {
  windowId: number;
  focused: boolean;
  incognito: boolean;
  type: string;
  tabIds: number[];
};

/**
 * Live snapshot of the user's actual browser tabs/windows, gathered
 * client-side (see src/lib/browser/context.ts) and handed to the server as
 * ordinary request data — exactly like `semanticHints`. This is what lets
 * Gemini's server-side list_browser_tabs/get_active_tab/list_browser_windows
 * actions (src/lib/actions/browser-read.ts) answer without the server ever
 * touching a chrome.* API itself. Defined here (a plain types-only module,
 * no "use client", no window access) rather than in context.ts so the
 * server-side action layer can import the type without pulling in any
 * client-only runtime code.
 */
export type BrowserContextSnapshot = {
  tabs: BrowserTabInfo[];
  windows: BrowserWindowInfo[];
  activeTabId: number | null;
};

/**
 * Wire shape for one `get_history` result item — mirrors
 * extension/src/browser-actions.js's getHistory mapping exactly. Deliberately
 * only what chrome.history.HistoryItem actually offers (see AGENTS.md's
 * History Dump spec, section 3): no page content, no per-visit referrer, no
 * device info.
 */
export type HistoryVisitItem = {
  url: string;
  title: string;
  /** Epoch ms of the item's most recent visit, per chrome.history.HistoryItem. */
  lastVisitTime: number;
  visitCount: number;
  historyItemId: string;
};

const MAX_OPEN_URL_LENGTH = 4000;

/**
 * The one definition of "a URL Hubble may open", and the rule every layer
 * defers to rather than restating:
 *
 * - `parseSingleUrl` (src/lib/tabs/parse.ts) — so an unsafe scheme never
 *   becomes a saved tab in the first place.
 * - `openTab` (./open-tab.ts) — so one already saved, from before that
 *   check existed, still cannot be opened.
 * - `webPlatform.openExternal` (src/lib/platform/web.ts) — the other
 *   window.open sink.
 * - extension/src/browser-commands.js keeps its own copy (no build step
 *   there, so it cannot import this one), and src-tauri/src/commands.rs
 *   keeps the equivalent match in Rust. Both are deliberate duplication at a
 *   process boundary: a content script is a transport, never a trust
 *   boundary, and the native layer should not trust the webview either.
 *
 * A safelist, not a blocklist, and a *structural* one — `new URL` then an
 * explicit protocol comparison. Substring checks are not enough:
 * `javascript://example.com/%0aalert(1)` parses cleanly, has a dotted
 * hostname, and contains "://", yet `//…` comments out the rest of the line
 * and `%0a` starts a new one, so it executes if it ever reaches a navigation
 * API. Malformed input throws out of `new URL` and fails closed.
 */
export function isSafeOpenUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_OPEN_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
