// Deliberately no imports here: MV3 content scripts declared via
// manifest.json have inconsistent ES-module support across Chrome
// versions, and this file only needs a handful of small, stable string
// constants — duplicating them is safer than risking a silent
// module-loading failure. Keep these in sync with extension/src/config.js
// if either ever changes.
const MESSAGE_SOURCE = "tabdump-extension";
const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
const MSG_CHECK_IMPORTED = "TABDUMP_CHECK_IMPORTED";
const MSG_CHECK_IMPORTED_RESULT = "TABDUMP_CHECK_IMPORTED_RESULT";
const MSG_BROWSER_COMMAND = "TABDUMP_BROWSER_COMMAND";
const MSG_BROWSER_COMMAND_RESULT = "TABDUMP_BROWSER_COMMAND_RESULT";
const MSG_EXTENSION_PING = "TABDUMP_EXTENSION_PING";
const MSG_EXTENSION_PONG = "TABDUMP_EXTENSION_PONG";

const CHECK_IMPORTED_TIMEOUT_MS = 1500;

// Bridges the extension's isolated world to the page's own JS context:
// content scripts share the DOM/window with the page for postMessage
// purposes, so this is received by the page's own `window.addEventListener`
// (see src/hooks/use-extension-import.ts), which validates it again before
// trusting it — a content script relaying a message is not itself a trust
// boundary, just a transport.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== MSG_TABDUMP_IMPORT) return;

  window.postMessage(
    { source: MESSAGE_SOURCE, type: MSG_TABDUMP_IMPORT, payload: message.payload },
    window.location.origin
  );
});

// Round-trips the popup's "which of these urls are already in the
// currently selected workspace?" query to the page and back (see
// src/hooks/use-extension-workspace-query.ts for the page-side responder).
// Bounded by a timeout so a page that hasn't mounted that responder yet (or
// never will) can't hang the popup open indefinitely — the popup treats a
// timeout exactly like "couldn't determine" and falls back gracefully.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_CHECK_IMPORTED) return undefined;

  const requestId = `${Date.now()}-${Math.random()}`;
  let settled = false;

  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener("message", handleResult);
  }

  function handleResult(event) {
    if (event.origin !== window.location.origin) return;
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE || data.type !== MSG_CHECK_IMPORTED_RESULT) return;
    if (data.payload?.requestId !== requestId) return;

    if (settled) return;
    settled = true;
    cleanup();
    sendResponse({ ok: true, existingUrls: data.payload.existingUrls ?? [] });
  }

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    sendResponse({ ok: false, reason: "timeout" });
  }, CHECK_IMPORTED_TIMEOUT_MS);

  window.addEventListener("message", handleResult);
  window.postMessage(
    { source: MESSAGE_SOURCE, type: MSG_CHECK_IMPORTED, payload: { requestId, urls: message.payload?.urls ?? [] } },
    window.location.origin
  );

  return true; // keep the message channel open for the async sendResponse
});

// Ask Tabs browser control: relays a typed BrowserCommand from the page
// straight through to background.js and posts the (equally typed) result
// back — this content script is purely a transport here, exactly like the
// TABDUMP_IMPORT/CHECK_IMPORTED relays above. It does not itself interpret
// `action`/`args` at all; background.js's allowlist + validators are the
// only place that decides what's allowed to run.
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== MESSAGE_SOURCE || data.type !== MSG_BROWSER_COMMAND) return;

  const { id, action, args } = data.payload ?? {};
  if (typeof id !== "string" || typeof action !== "string") return;

  chrome.runtime
    .sendMessage({ type: MSG_BROWSER_COMMAND, payload: { id, action, args } })
    .then((response) => {
      window.postMessage(
        { source: MESSAGE_SOURCE, type: MSG_BROWSER_COMMAND_RESULT, payload: response ?? { id, ok: false, error: "no-response" } },
        window.location.origin
      );
    })
    .catch(() => {
      window.postMessage(
        { source: MESSAGE_SOURCE, type: MSG_BROWSER_COMMAND_RESULT, payload: { id, ok: false, error: "extension-unreachable" } },
        window.location.origin
      );
    });
});

// Connection-liveness: answered entirely within this content script (no
// background trip) since the content script only runs when the extension is
// installed and enabled — its mere presence here IS the "connected" signal.
// See src/hooks/use-browser-connection.ts for the page-side ping loop.
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== MESSAGE_SOURCE || data.type !== MSG_EXTENSION_PING) return;

  const requestId = data.payload?.requestId;
  window.postMessage(
    { source: MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId } },
    window.location.origin
  );
});

// Also announce readiness proactively as soon as this script attaches, so a
// page whose connection-indicator effect mounted first doesn't have to wait
// for its own next ping interval to find out the extension is here.
window.postMessage(
  { source: MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId: null } },
  window.location.origin
);
