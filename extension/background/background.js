import {
  TABDUMP_ORIGIN,
  MSG_DUMP_TABS,
  MSG_TABDUMP_IMPORT,
  MSG_CHECK_IMPORTED,
  MSG_BROWSER_COMMAND,
} from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";
import { validateBrowserCommand } from "../src/browser-commands.js";
import { BROWSER_ACTION_HANDLERS } from "../src/browser-actions.js";

// A couple of short retries in case the content script hasn't finished
// attaching its listener yet — see waitForTabComplete's comment for why
// this is a backstop rather than the primary mechanism.
const SEND_RETRY_DELAYS_MS = [150, 350];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendImportToTab(tabId, payload) {
  for (const delay of [0, ...SEND_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      await chrome.tabs.sendMessage(tabId, { type: MSG_TABDUMP_IMPORT, payload });
      return true;
    } catch {
      // Receiving end not ready yet (or gone) — try again, or give up after
      // the last attempt.
    }
  }
  return false;
}

const TAB_READY_TIMEOUT_MS = 8000;

// Newly-created tabs need their content script to have attached before a
// message can land. `status: "complete"` fires around the page's `load`
// event, and a `document_idle` content script (the default `run_at`, used
// here) always attaches before `load` — so waiting for "complete" is a
// reliable, race-free way to know the tab is ready, without polling.
//
// Bounded two ways so this can never hang `dumpTabs()` forever: a timeout
// (the page might never finish loading — blocked request, offline, etc.)
// and an onRemoved listener (the user might close the tab before it loads).
// Either one always cleans up both listeners.
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let settled = false;

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    }

    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) finish();
    }

    const timer = setTimeout(finish, TAB_READY_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function findOrOpenTabDumpTab() {
  const [existing] = await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing.id;
  }

  const created = await chrome.tabs.create({ url: TABDUMP_ORIGIN });
  await waitForTabComplete(created.id);
  return created.id;
}

async function dumpTabs(excludeUrls) {
  const chromeTabs = await chrome.tabs.query({ currentWindow: true });
  const payload = buildImportPayload(chromeTabs, excludeUrls);

  if (payload.tabs.length === 0) {
    return { ok: false, reason: "no-importable-tabs", count: 0 };
  }

  const tabId = await findOrOpenTabDumpTab();
  const delivered = await sendImportToTab(tabId, payload);

  return delivered
    ? { ok: true, count: payload.tabs.length }
    : { ok: false, reason: "delivery-failed", count: payload.tabs.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_DUMP_TABS) return undefined;

  dumpTabs(message.payload?.excludeUrls)
    .then(sendResponse)
    .catch((err) => {
      console.error("TabDump: dumpTabs failed", err);
      sendResponse({ ok: false, reason: "unexpected-error", count: 0 });
    });

  return true; // keep the message channel open for the async sendResponse
});

// Answers "which of these urls are already in the currently selected
// workspace?" by relaying to an *already open* TabDump tab's content
// script — deliberately never opens or focuses one just to check, since
// that would be a surprising side effect of simply opening the popup.
// Genuinely unknowable without an open tab (or if the page doesn't answer
// in time), in which case the popup falls back to its plain wording.
async function checkImported(urls) {
  const [existing] = await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` });
  if (!existing) return { ok: false, reason: "no-tabdump-tab" };

  try {
    const response = await chrome.tabs.sendMessage(existing.id, {
      type: MSG_CHECK_IMPORTED,
      payload: { urls },
    });
    return response ?? { ok: false, reason: "no-response" };
  } catch {
    return { ok: false, reason: "delivery-failed" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_CHECK_IMPORTED) return undefined;

  checkImported(message.payload?.urls ?? [])
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: "unexpected-error" }));

  return true; // keep the message channel open for the async sendResponse
});

/**
 * Ask Tabs browser control: the single dispatch point for every
 * TABDUMP_BROWSER_COMMAND relayed up from content-script.js. Two checks
 * happen before any chrome.* API is touched, in order: (1) is `action` one
 * of the allowlisted names in BROWSER_ACTION_HANDLERS at all, and (2) does
 * `args` pass that action's own validator. A content script (or, further
 * back, the web page) is never trusted just because the message arrived
 * through the expected channel — see AGENTS.md section 14.
 */
async function handleBrowserCommand({ id, action, args }, senderTabId) {
  const validated = validateBrowserCommand(action, args);
  if (!validated.ok) {
    return { id, ok: false, error: validated.error };
  }

  const handler = BROWSER_ACTION_HANDLERS[action];
  if (!handler) {
    // Unreachable in practice (validateBrowserCommand's allowlist and this
    // handler map are drawn from the same action names), but a defensive
    // fallback beats ever assuming a validated name is dispatchable.
    return { id, ok: false, error: `No handler registered for "${action}".` };
  }

  try {
    // senderTabId is only meaningful to openUrl's reuseCurrentTab handling
    // (see browser-actions.js) — every other handler ignores this second arg.
    const result = await handler(validated.args, { senderTabId });
    return { id, ok: true, result };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : "Browser command failed." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG_BROWSER_COMMAND) return undefined;

  const payload = message.payload ?? {};
  if (typeof payload.id !== "string" || typeof payload.action !== "string") {
    sendResponse({ id: typeof payload.id === "string" ? payload.id : "", ok: false, error: "Malformed browser command." });
    return undefined;
  }

  handleBrowserCommand(payload, sender.tab?.id)
    .then(sendResponse)
    .catch(() => sendResponse({ id: payload.id, ok: false, error: "Unexpected error running browser command." }));

  return true; // keep the message channel open for the async sendResponse
});
