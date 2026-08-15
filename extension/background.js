// Thin privileged bridge between the TabDump web app and Chrome's tabs API.
//
// This script intentionally contains no URL-matching or business logic --
// see src/lib/tabs/extension-bridge.ts in the TabDump repo for that. It only
// ever does what it's told: list tabs, or focus one by id. It never reads
// page content and never persists anything -- every LIST_TABS request is a
// fresh chrome.tabs.query({}) call, and nothing is cached between requests.

const ALLOWED_ORIGINS = ["http://localhost:3000", "https://tabsdump.vercel.app"];

function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.includes(origin);
}

function isValidId(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function toTabInfo(tab) {
  return {
    id: tab.id,
    url: tab.url,
    windowId: tab.windowId,
    lastAccessed: tab.lastAccessed,
  };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // externally_connectable in manifest.json already restricts which origins
  // can reach this listener at all. This check is defense-in-depth, not the
  // primary enforcement -- it makes the rejection explicit and auditable
  // rather than relying solely on manifest configuration.
  if (!isAllowedOrigin(sender.origin)) {
    sendResponse({ ok: false, error: "unauthorized origin" });
    return false;
  }

  if (!message || typeof message.type !== "string") {
    sendResponse({ ok: false, error: "malformed message" });
    return false;
  }

  switch (message.type) {
    case "PING": {
      sendResponse({ ok: true });
      return false;
    }

    case "LIST_TABS": {
      chrome.tabs
        .query({})
        .then((tabs) => sendResponse(tabs.map(toTabInfo)))
        .catch(() => sendResponse(null));
      return true; // keep the message channel open for the async response
    }

    case "FOCUS_TAB": {
      if (!isValidId(message.tabId) || !isValidId(message.windowId)) {
        sendResponse({ ok: false, error: "invalid tab or window id" });
        return false;
      }
      chrome.tabs
        .update(message.tabId, { active: true })
        .then(() => chrome.windows.update(message.windowId, { focused: true }))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false, error: "tab no longer exists" }));
      return true; // keep the message channel open for the async response
    }

    default: {
      sendResponse({ ok: false, error: "unknown message type" });
      return false;
    }
  }
});
