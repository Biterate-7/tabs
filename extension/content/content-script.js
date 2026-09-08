// Deliberately no imports here: MV3 content scripts declared via
// manifest.json have inconsistent ES-module support across Chrome
// versions, and this file only needs a handful of small, stable string
// constants — duplicating them is safer than risking a silent
// module-loading failure. Keep these in sync with extension/src/config.js
// if either ever changes.
const MESSAGE_SOURCE = "tabdump-extension";
const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
const MSG_TABDUMP_IMPORT_ACK = "TABDUMP_IMPORT_ACK";
const MSG_TABDUMP_PAGE_READY = "TABDUMP_PAGE_READY";
const MSG_CHECK_IMPORTED = "TABDUMP_CHECK_IMPORTED";
const MSG_CHECK_IMPORTED_RESULT = "TABDUMP_CHECK_IMPORTED_RESULT";
const MSG_BROWSER_COMMAND = "TABDUMP_BROWSER_COMMAND";
const MSG_BROWSER_COMMAND_RESULT = "TABDUMP_BROWSER_COMMAND_RESULT";
const MSG_EXTENSION_PING = "TABDUMP_EXTENSION_PING";
const MSG_EXTENSION_PONG = "TABDUMP_EXTENSION_PONG";

const CHECK_IMPORTED_TIMEOUT_MS = 1500;
// Mirrors config.js's IMPORT_ACK_TIMEOUT_MS. Duplicated for the same
// no-ES-module reason as the constants above; background.js's own budget
// arithmetic reads the canonical value from config.js.
const IMPORT_ACK_TIMEOUT_MS = 8000;

// Single-prefixed diagnostics for the one question a cross-machine dump
// failure always turns on: is this receiver actually here? Chrome reports a
// missing content script only as "Could not establish connection. Receiving
// end does not exist." on the *sender* side, which cannot tell "never
// injected" apart from "injected, then crashed before registering". These two
// lines, read from the page console, settle that immediately.
//
// Logs no url, title or page content — the diagnostic value is entirely in
// whether the lines appear at all.
function log(stage) {
  console.log(`[TAB-DUMP-CONTENT] ${stage}`);
}

log("loaded");

// Whether THIS copy of the script is the one that owns the listeners.
//
// background.js repairs a tab whose content script is missing by injecting
// this same file with chrome.scripting.executeScript (see
// ensureContentScriptInjected there). That injection shares the isolated
// world with any manifest-declared copy, so a copy landing in a tab that
// already has one must register nothing: two live listener sets would each
// hold their own `pendingImport` and each answer background.js on the same
// port, making which response wins a race rather than a fact.
//
// The flag is read once, before it is set, so the first copy through always
// takes ownership and every later one is inert.
const alreadyRegistered = window.__tabdumpBridgeRegistered === true;
window.__tabdumpBridgeRegistered = true;

/** Registers a background→content-script listener, unless this copy is a duplicate. */
function onExtensionMessage(listener) {
  if (!alreadyRegistered) chrome.runtime.onMessage.addListener(listener);
}

/** Registers a page→content-script listener, unless this copy is a duplicate. */
function onPageMessage(listener) {
  if (!alreadyRegistered) window.addEventListener("message", listener);
}

// Whether the page has told us it can ingest an import (see
// src/hooks/use-extension-import.ts, which posts MSG_TABDUMP_PAGE_READY from
// the same effect that attaches its `message` listener). A page reload tears
// this whole content script down with the document, so this can never
// outlive the page it describes.
let pageReady = false;

// The one import currently waiting on the page, if any:
// `{ importId, payload, respond, timer }`. Held rather than fired-and-
// forgotten because the payload routinely arrives BEFORE the page is ready —
// background.js sends the moment chrome.tabs reports `status: "complete"`,
// and the app's listener demonstrably attaches after the load event, not
// before. Holding it here (and re-posting on MSG_TABDUMP_PAGE_READY below)
// is what makes delivery ordering-independent instead of a race.
let pendingImport = null;

function settlePendingImport(response) {
  if (!pendingImport) return;
  const { respond, timer } = pendingImport;
  pendingImport = null;
  clearTimeout(timer);
  try {
    respond(response);
  } catch {
    // The background service worker's message port is already gone (it was
    // evicted, or the extension reloaded). Nothing to deliver the answer to;
    // background.js treats a dropped port as a delivery failure and reports
    // it, so this can't turn into a silent success.
  }
}

function postImportToPage(importId, payload) {
  window.postMessage(
    { source: MESSAGE_SOURCE, type: MSG_TABDUMP_IMPORT, payload: { ...payload, importId } },
    window.location.origin
  );
}

/**
 * Bridges the extension's isolated world to the page's own JS context:
 * content scripts share the DOM/window with the page for postMessage
 * purposes, so this is received by the page's own `window.addEventListener`
 * (see src/hooks/use-extension-import.ts), which validates it again before
 * trusting it — a content script relaying a message is not itself a trust
 * boundary, just a transport.
 *
 * Unlike the fire-and-forget relay this replaced, the response to
 * background.js is deferred until the page acks the batch. That makes
 * "delivered" mean "the web app took ownership of these tabs" rather than
 * merely "a content script was attached", which is the distinction the whole
 * cross-machine dump failure turned on.
 */
onExtensionMessage((message, _sender, sendResponse) => {
  if (message?.type !== MSG_TABDUMP_IMPORT) return undefined;

  const importId = typeof message.importId === "string" ? message.importId : `${Date.now()}-${Math.random()}`;

  // A second import while one is still pending: answer the first honestly
  // (it never got acked) rather than leaving background.js's port hanging.
  settlePendingImport({ ok: false, reason: "superseded" });

  const timer = setTimeout(() => {
    settlePendingImport({ ok: false, reason: pageReady ? "no-ack" : "page-not-ready" });
  }, IMPORT_ACK_TIMEOUT_MS);

  pendingImport = { importId, payload: message.payload, respond: sendResponse, timer };
  postImportToPage(importId, message.payload);

  return true; // keep the message channel open until the page acks
});

// The page's ack — the only thing that turns a delivery into a success.
onPageMessage((event) => {
  if (event.origin !== window.location.origin) return;
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== MESSAGE_SOURCE || data.type !== MSG_TABDUMP_IMPORT_ACK) return;
  if (!pendingImport || data.payload?.importId !== pendingImport.importId) return;

  const accepted = Number(data.payload?.accepted);
  settlePendingImport({ ok: true, accepted: Number.isFinite(accepted) ? accepted : 0 });
});

// The page announcing it can ingest imports. Re-posting any held payload
// here is the actual fix for the hydration race: the batch that arrived
// while React was still hydrating is delivered again the instant a listener
// exists, instead of having been dropped into a document nobody was
// listening to.
onPageMessage((event) => {
  if (event.origin !== window.location.origin) return;
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== MESSAGE_SOURCE || data.type !== MSG_TABDUMP_PAGE_READY) return;

  pageReady = true;
  if (pendingImport) postImportToPage(pendingImport.importId, pendingImport.payload);
});

// Round-trips the popup's "which of these urls are already in the
// currently selected workspace?" query to the page and back (see
// src/hooks/use-extension-workspace-query.ts for the page-side responder).
// Bounded by a timeout so a page that hasn't mounted that responder yet (or
// never will) can't hang the popup open indefinitely — the popup treats a
// timeout exactly like "couldn't determine" and falls back gracefully.
onExtensionMessage((message, _sender, sendResponse) => {
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
onPageMessage((event) => {
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
// See src/lib/browser/bridge.ts for the page-side ping loop.
onPageMessage((event) => {
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

log(alreadyRegistered ? "duplicate-copy-inert" : "message-listener-ready");

// Also announce readiness proactively as soon as this script attaches, so a
// page whose connection-indicator effect mounted first doesn't have to wait
// for its own next ping interval to find out the extension is here.
window.postMessage(
  { source: MESSAGE_SOURCE, type: MSG_EXTENSION_PONG, payload: { requestId: null } },
  window.location.origin
);
