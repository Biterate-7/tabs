import { TABDUMP_ORIGIN, MSG_DUMP_TABS, MSG_TABDUMP_IMPORT } from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";

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

async function dumpTabs() {
  const chromeTabs = await chrome.tabs.query({ currentWindow: true });
  const payload = buildImportPayload(chromeTabs);

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

  dumpTabs()
    .then(sendResponse)
    .catch((err) => {
      console.error("TabDump: dumpTabs failed", err);
      sendResponse({ ok: false, reason: "unexpected-error", count: 0 });
    });

  return true; // keep the message channel open for the async sendResponse
});
