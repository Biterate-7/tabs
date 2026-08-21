// Deliberately no imports here: MV3 content scripts declared via
// manifest.json have inconsistent ES-module support across Chrome
// versions, and this file only needs two small, stable string constants —
// duplicating them is safer than risking a silent module-loading failure.
// Keep these in sync with extension/src/config.js if either ever changes.
const MESSAGE_SOURCE = "tabdump-extension";
const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";

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
