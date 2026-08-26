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

const MAX_URLS_PER_COMMAND = 50;
const MAX_TAB_IDS_PER_COMMAND = 200;

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
  return validator(args ?? {});
}
