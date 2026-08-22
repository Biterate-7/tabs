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
 *
 * `excludeUrls`, when given, drops tabs whose exact raw URL is already
 * known to be in the currently selected workspace (see
 * background.js's checkImported) — this is what lets "Dump N new tabs"
 * actually only dump the new ones, through the same payload-building path
 * every other dump already uses, rather than a second filtering step
 * bolted on elsewhere.
 */
export function buildImportPayload(chromeTabs, excludeUrls) {
  const exclude = excludeUrls ? new Set(excludeUrls) : null;
  const tabs = [];

  for (const tab of chromeTabs ?? []) {
    if (!tab || !tab.url || isPrivilegedUrl(tab.url)) continue;
    if (exclude && exclude.has(tab.url)) continue;

    // A tab still mid-navigation (status "loading") hasn't rendered its real
    // <title> yet — chrome.tabs.Tab.title at that moment is a placeholder,
    // not the page's actual title. Omitting it (rather than forwarding the
    // placeholder) lets TabDump's own title-resolution fallback fetch the
    // real title server-side instead of getting stuck with a bad value.
    // `status` is undefined only in tests that don't set it — treated as
    // trustworthy there, matching prior behavior for existing callers.
    const titleIsLoaded = tab.status === undefined || tab.status === "complete";

    tabs.push({
      url: tab.url,
      title: titleIsLoaded && tab.title ? tab.title : undefined,
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
      tabId: tab.id,
      windowId: tab.windowId,
    });
  }

  return { tabs };
}
