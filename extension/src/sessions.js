// Sessions: what "Save session" reads from Chrome. Pure — no `chrome.*`
// calls here (same discipline as tabs.js); background.js queries the windows
// and hands their tabs to buildSessionCapture.
//
// Only addresses, titles, Chrome's icon and whether a tab is pinned are kept.
// No page content, cookies or form values are read. Hubble (the page at
// `selfOrigin`) re-checks every tab before it stores the session.

import { isSafeOpenUrl, MAX_SESSION_TABS } from "./browser-commands.js";

/**
 * The tabs to save from `windows` (chrome.windows.Window objects with their
 * tabs), window by window and each in tab-strip order.
 *
 * Left out, and counted so the popup can say the save is incomplete:
 *  - `restricted`: browser pages Chrome won't reopen from an extension
 *    (chrome://, the Web Store, new tabs, file:// …)
 *  - `privateTabs`: tabs in private (incognito) windows, never saved
 * Hubble's own tabs are left out without being counted.
 */
export function buildSessionCapture(windows, selfOrigin) {
  const tabs = [];
  let restricted = 0;
  let privateTabs = 0;

  for (const win of windows ?? []) {
    const own = [...(win?.tabs ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (win?.incognito) {
      privateTabs += own.length;
      continue;
    }
    for (const tab of own) {
      const url = tab?.url ?? tab?.pendingUrl ?? "";
      if (isHubble(url, selfOrigin)) continue;
      if (!isSafeOpenUrl(url)) {
        restricted += 1;
        continue;
      }
      // Mid-navigation, Chrome's title is a placeholder; Hubble shows the address instead.
      const loaded = tab.status === undefined || tab.status === "complete";
      tabs.push({
        url,
        ...(loaded && tab.title ? { title: tab.title } : {}),
        ...(loaded && typeof tab.favIconUrl === "string" && /^https?:/i.test(tab.favIconUrl) ? { favicon: tab.favIconUrl } : {}),
        ...(tab.pinned ? { pinned: true } : {}),
      });
    }
  }

  const tooMany = Math.max(0, tabs.length - MAX_SESSION_TABS);
  return { tabs: tabs.slice(0, MAX_SESSION_TABS), restricted, privateTabs, tooMany };
}

function isHubble(url, selfOrigin) {
  if (!selfOrigin) return false;
  try {
    return new URL(url).origin === selfOrigin;
  } catch {
    return false;
  }
}

/** The popup's one line about what a save left out, or "" when it saved everything. */
export function describeLeftOut({ restricted = 0, privateTabs = 0, tooMany = 0, dropped = 0 }) {
  const parts = [];
  const browserPages = restricted + dropped;
  if (browserPages > 0) parts.push(`${browserPages} browser ${browserPages === 1 ? "page" : "pages"}`);
  if (privateTabs > 0) parts.push(`${privateTabs} private ${privateTabs === 1 ? "tab" : "tabs"}`);
  if (tooMany > 0) parts.push(`${tooMany} over the ${MAX_SESSION_TABS}-tab limit`);
  return parts.length === 0 ? "" : `Not saved: ${parts.join(", ")}.`;
}

/** What the popup says when a save didn't happen, from the reason the background or Hubble gave. */
export function describeSaveFailure(error) {
  switch (error) {
    case "empty":
    case "session-empty":
      return "There are no web pages to save in this window.";
    case "private-window":
      return "Private windows aren't saved.";
    case "no-hubble-tab":
    case "hubble-unreachable":
    case "no-response":
    case "timeout":
      return "Couldn't reach Hubble. Open Hubble and try again — nothing was saved.";
    case "not-ready":
      return "Hubble is still loading. Try again in a moment — nothing was saved.";
    case "project-missing":
      return "That project is no longer in Hubble. Choose another — nothing was saved.";
    case "storage-failed":
      return "Hubble couldn't store the session (browser storage is full or blocked). Nothing was saved.";
    case "too-many-sessions":
      return "You have too many saved sessions. Delete some in Hubble, then try again.";
    case "read-only":
      return "Your sessions were saved by a newer version of Hubble. Reload Hubble, then try again.";
    default:
      return "Couldn't save the session. Nothing was saved.";
  }
}
