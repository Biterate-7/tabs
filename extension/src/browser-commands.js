// Pure logic only — no `chrome.*` calls in this file (same discipline as
// tabs.js), so the allowlist and every validator can be unit tested without
// mocking browser APIs. background.js is the only place that actually calls
// chrome.tabs/chrome.windows, and only after a command has passed through
// `validateBrowserCommand` here.
//
// This is the security boundary described in AGENTS.md's Chrome Browser
// Control spec: an explicit allowlist of action names, strict per-action
// argument validation, and a safelist (not a blocklist) of URL schemes for
// anything that opens a tab — so a malformed or malicious
// TABDUMP_BROWSER_COMMAND message can never reach a chrome.* call with
// unvalidated data, regardless of what page or script produced it.

import { DESKTOP_BRIDGE_PORTS } from "./desktop.js";

const MAX_URLS_PER_COMMAND = 50;
// What Hubble Desktop may ask Chrome through its relay (RELAY_ACTIONS in
// src-tauri/src/import_bridge.rs), and the answer's size cap (MAX_RELAY_BODY_BYTES).
export const RELAY_ACTIONS = Object.freeze(["browser_tabs", "history"]);
const MAX_RELAY_CHARS = 8 * 1024 * 1024;
const MAX_TAB_IDS_PER_COMMAND = 200;
const MAX_HISTORY_RESULTS = 5000;
// Mirrors MAX_SESSION_TABS in src/lib/sessions/types.ts.
export const MAX_SESSION_TABS = 200;
const MAX_CONTEXT_KEYS = 400;
const CONTEXT_PROVIDERS = ["chatgpt", "claude", "gemini", "perplexity"];

/**
 * Context detection's commands: only the Hubble page may send them
 * (background.js checks the sender too), and each answers about this
 * browser's own activity store — never another site's data.
 */
/** The Hubble account a context command claims to be for: an account id, or null signed out. Verified by background.js. */
const CONTEXT_ACCOUNT = /^[A-Za-z0-9_-]{1,200}$/;

export const CONTEXT_ACTIONS = Object.freeze([
  "get_context_settings",
  "set_context_settings",
  "request_context_access",
  "get_context_activity",
  "forget_context_activity",
  "clear_context_activity",
  "capture_context_conversation",
]);

/**
 * Safelist, not a blocklist: only ever open http/https URLs. This is
 * deliberately stricter than tabs.js's isPrivilegedUrl (which blocklists
 * chrome://, javascript: is not even in that list) because opening a tab is
 * a more dangerous primitive than reading one that's already open — a
 * `javascript:` or `data:` URL handed to chrome.tabs.create would run
 * attacker-controlled content, so only the two ordinary web schemes pass.
 */
export function isSafeOpenUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 4000) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyArray(value, itemCheck, maxLength) {
  return Array.isArray(value) && value.length > 0 && value.length <= maxLength && value.every(itemCheck);
}

function ok(args) {
  return { ok: true, args };
}

function fail(error) {
  return { ok: false, error };
}

/**
 * One validator per allowlisted action. Every entry both DEFINES the
 * allowlist (only these keys are ever dispatched — see background.js) and
 * enforces that action's argument shape before anything touches chrome.*.
 * Deliberately hand-rolled rather than a schema library, matching
 * src/lib/actions/validate.ts's style on the web-app side of this same
 * feature.
 */
export const BROWSER_COMMAND_VALIDATORS = {
  list_browser_tabs(args) {
    return ok({ windowId: isPositiveInteger(args?.windowId) ? args.windowId : undefined });
  },

  get_active_tab() {
    return ok({});
  },

  list_browser_windows() {
    return ok({});
  },

  /**
   * History Dump's scan request. `startTime`/`endTime` are epoch ms —
   * `startTime` is required (there is no sane "scan everything" default for
   * a feature explicitly about a bounded, user-chosen time range) while
   * `endTime` defaults to "now" in browser-actions.js when omitted.
   * `maxResults` is capped well above what any real UI review step would
   * ever want to render, purely as defense-in-depth against a malformed
   * request forcing an unbounded chrome.history.search().
   */
  get_history(args) {
    if (typeof args?.startTime !== "number" || !Number.isFinite(args.startTime) || args.startTime < 0) {
      return fail("`startTime` must be a non-negative number (epoch ms).");
    }
    const endTime = args?.endTime === undefined ? undefined : args.endTime;
    if (endTime !== undefined && (typeof endTime !== "number" || !Number.isFinite(endTime) || endTime < args.startTime)) {
      return fail("`endTime` must be a number (epoch ms) not earlier than `startTime`.");
    }
    let maxResults = MAX_HISTORY_RESULTS;
    if (args?.maxResults !== undefined) {
      if (!isPositiveInteger(args.maxResults) || args.maxResults === 0) {
        return fail(`\`maxResults\` must be a positive integer up to ${MAX_HISTORY_RESULTS}.`);
      }
      maxResults = Math.min(args.maxResults, MAX_HISTORY_RESULTS);
    }
    return ok({ startTime: args.startTime, endTime, maxResults });
  },

  open_url(args) {
    if (!isSafeOpenUrl(args?.url)) return fail("`url` must be an http(s) URL.");
    return ok({ url: args.url, active: args?.active !== false, reuseCurrentTab: Boolean(args?.reuseCurrentTab) });
  },

  open_tabs(args) {
    if (!isNonEmptyArray(args?.urls, isSafeOpenUrl, MAX_URLS_PER_COMMAND)) {
      return fail(`\`urls\` must be a non-empty array of up to ${MAX_URLS_PER_COMMAND} http(s) URLs.`);
    }
    return ok({ urls: args.urls, newWindow: Boolean(args?.newWindow) });
  },

  /**
   * Sessions: reopen a saved session in a new window. `requestId` lets
   * browser-actions.js answer a repeated request with the first one's result
   * instead of opening the tabs again. Every address is checked here, and the
   * count is bounded, so a page can never make this open an arbitrary number
   * of tabs or anything but an ordinary web page.
   */
  open_session(args) {
    const requestId = args?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 100) {
      return fail("`requestId` must be a non-empty string of up to 100 characters.");
    }
    const tabs = args?.tabs;
    const valid = (tab) =>
      tab !== null && typeof tab === "object" && isSafeOpenUrl(tab.url) && (tab.pinned === undefined || typeof tab.pinned === "boolean");
    if (!isNonEmptyArray(tabs, valid, MAX_SESSION_TABS)) {
      return fail(`\`tabs\` must be a non-empty array of up to ${MAX_SESSION_TABS} http(s) URLs.`);
    }
    return ok({ requestId, tabs: tabs.map((tab) => ({ url: tab.url, pinned: tab.pinned === true })) });
  },

  close_tab(args) {
    if (!isPositiveInteger(args?.tabId)) return fail("`tabId` must be a non-negative integer.");
    return ok({ tabId: args.tabId });
  },

  close_tabs(args) {
    if (!isNonEmptyArray(args?.tabIds, isPositiveInteger, MAX_TAB_IDS_PER_COMMAND)) {
      return fail(`\`tabIds\` must be a non-empty array of up to ${MAX_TAB_IDS_PER_COMMAND} integers.`);
    }
    return ok({ tabIds: args.tabIds });
  },

  pin_tab(args) {
    if (!isPositiveInteger(args?.tabId)) return fail("`tabId` must be a non-negative integer.");
    return ok({ tabId: args.tabId, pinned: true });
  },

  unpin_tab(args) {
    if (!isPositiveInteger(args?.tabId)) return fail("`tabId` must be a non-negative integer.");
    return ok({ tabId: args.tabId, pinned: false });
  },

  move_tabs_to_window(args) {
    if (!isNonEmptyArray(args?.tabIds, isPositiveInteger, MAX_TAB_IDS_PER_COMMAND)) {
      return fail(`\`tabIds\` must be a non-empty array of up to ${MAX_TAB_IDS_PER_COMMAND} integers.`);
    }
    if (!isPositiveInteger(args?.windowId)) return fail("`windowId` must be a non-negative integer.");
    return ok({ tabIds: args.tabIds, windowId: args.windowId });
  },

  /**
   * Hubble Desktop asked Chrome something (src-tauri/src/import_bridge.rs,
   * "The relay"): the relay page on Hubble's site showed the person what was
   * asked, they pressed Send, and the page read the answer with the commands
   * above. This hands that answer to the app on loopback, with the one-time
   * secret the app put in the page's fragment. It reads nothing from Chrome
   * itself, and it can reach only Hubble Desktop's own ports.
   */
  deliver_to_desktop(args) {
    if (!DESKTOP_BRIDGE_PORTS.includes(args?.port)) return fail("`port` must be one of Hubble Desktop's ports.");
    if (typeof args?.id !== "string" || !/^[0-9a-f]{32}$/.test(args.id)) return fail("`id` must be a relay id.");
    if (typeof args?.secret !== "string" || !/^[0-9a-f]{64}$/.test(args.secret)) return fail("`secret` must be a relay secret.");
    if (!RELAY_ACTIONS.includes(args?.action)) return fail(`\`action\` must be one of ${RELAY_ACTIONS.join(", ")}.`);
    if (args.ok === true) {
      if (args.result === null || typeof args.result !== "object" || Array.isArray(args.result)) return fail("`result` must be an object.");
    } else if (args.ok !== false || typeof args.error !== "string") {
      return fail("Expected `ok: true` with `result`, or `ok: false` with `error`.");
    }
    let size = 0;
    try {
      size = JSON.stringify(args).length;
    } catch {
      return fail("The answer must be plain data.");
    }
    if (size > MAX_RELAY_CHARS) return fail("The answer is too large.");
    return ok(
      args.ok
        ? { port: args.port, id: args.id, secret: args.secret, action: args.action, ok: true, result: args.result }
        : { port: args.port, id: args.id, secret: args.secret, action: args.action, ok: false, error: args.error.slice(0, 300) }
    );
  },

  get_context_settings() {
    return ok({});
  },

  /** The settings are re-read field by field in context-activity.js (readContextSettings); here only the envelope. */
  set_context_settings(args) {
    const settings = args?.settings;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return fail("`settings` must be an object.");
    let size = 0;
    try {
      size = JSON.stringify(settings).length;
    } catch {
      return fail("`settings` must be plain data.");
    }
    if (size > 20000) return fail("`settings` is too large.");
    return ok({ settings });
  },

  request_context_access(args) {
    if (!CONTEXT_PROVIDERS.includes(args?.provider)) return fail(`\`provider\` must be one of ${CONTEXT_PROVIDERS.join(", ")}.`);
    return ok({ provider: args.provider });
  },

  get_context_activity(args) {
    const since = args?.since;
    const epoch = args?.epoch;
    if (since !== undefined && !isPositiveInteger(since)) return fail("`since` must be a non-negative integer.");
    if (epoch !== undefined && (typeof epoch !== "string" || epoch.length === 0 || epoch.length > 200)) return fail("`epoch` must be a string.");
    return ok({ ...(since !== undefined ? { since } : {}), ...(epoch !== undefined ? { epoch } : {}) });
  },

  forget_context_activity(args) {
    const valid = (key) => typeof key === "string" && key.length > 0 && key.length <= 2100;
    if (!isNonEmptyArray(args?.keys, valid, MAX_CONTEXT_KEYS)) return fail(`\`keys\` must be a non-empty array of up to ${MAX_CONTEXT_KEYS} keys.`);
    return ok({ keys: args.keys });
  },

  clear_context_activity() {
    return ok({});
  },

  /** Saves an open AI conversation into a project through the ordinary Save to Hubble job. */
  capture_context_conversation(args) {
    if (!isSafeOpenUrl(args?.url)) return fail("`url` must be an http(s) URL.");
    const workspaceId = args?.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 200) return fail("`workspaceId` must be a project id.");
    return ok({ url: args.url, workspaceId });
  },

  create_browser_window(args) {
    const urls = args?.urls === undefined ? [] : args.urls;
    if (!Array.isArray(urls) || urls.length > MAX_URLS_PER_COMMAND || !urls.every(isSafeOpenUrl)) {
      return fail(`\`urls\` must be an array of up to ${MAX_URLS_PER_COMMAND} http(s) URLs (or omitted).`);
    }
    return ok({ urls, focused: args?.focused !== false });
  },
};

export const ALLOWED_BROWSER_ACTIONS = Object.freeze(Object.keys(BROWSER_COMMAND_VALIDATORS));

/**
 * The single choke point every incoming TABDUMP_BROWSER_COMMAND passes
 * through in background.js. Rejects anything not on the allowlist outright
 * — there is no default/fallthrough handler — and otherwise delegates to
 * that action's own validator.
 */
export function validateBrowserCommand(action, args) {
  const validator = BROWSER_COMMAND_VALIDATORS[action];
  if (!validator) return fail(`Unknown or disallowed browser action "${action}".`);
  if (!CONTEXT_ACTIONS.includes(action)) return validator(args ?? {});
  // Context detection: every command claims the Hubble account it is for. The claim is only checked for shape
  // here; background.js acts on it only when Hubble's server says the browser is signed in as that account.
  const account = args?.account;
  if (!(account === null || (typeof account === "string" && CONTEXT_ACCOUNT.test(account)))) return fail("`account` must be the signed-in account's id, or null signed out.");
  const checked = validator(args ?? {});
  return checked.ok ? ok({ ...checked.args, account }) : checked;
}
