// Pure logic only — no `chrome.*` calls in this file, so it can be unit
// tested directly (see tabs.test.js) without mocking browser APIs. The
// background/popup scripts own the actual chrome.tabs.query() calls and
// hand the raw results to buildImportPayload().

const PRIVILEGED_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "devtools:",
  "edge:",
  "about:",
  "view-source:",
  "moz-extension:",
];

/**
 * True for browser-internal/privileged pages that can't meaningfully be
 * imported (chrome://, chrome-extension://, devtools://, etc.) — never for
 * ordinary websites, no matter how unusual their content.
 */
export function isPrivilegedUrl(url) {
  try {
    const parsed = new URL(url);
    return PRIVILEGED_SCHEMES.includes(parsed.protocol);
  } catch {
    // Not a parseable URL at all — exclude rather than forward garbage.
    return true;
  }
}

/**
 * Converts raw `chrome.tabs.Tab` objects into the wire payload TabDump's
 * content-script bridge expects. `tabId`/`windowId`/`active` are carried
 * for the extension's own potential future use (e.g. closing tabs after a
 * successful dump) — TabDump's web app only consumes url/title/pinned.
 */
export function buildImportPayload(chromeTabs) {
  const tabs = [];

  for (const tab of chromeTabs ?? []) {
    if (!tab || !tab.url || isPrivilegedUrl(tab.url)) continue;

    tabs.push({
      url: tab.url,
      title: tab.title || undefined,
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
      tabId: tab.id,
      windowId: tab.windowId,
    });
  }

  return { tabs };
}
