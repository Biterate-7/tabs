"use client"

import { toast } from "sonner"
import { isBrowserConnected, sendBrowserCommand } from "./bridge"
import type { BrowserTabInfo } from "./protocol"

/**
 * Opens a URL the user clicked on in TabDump (a saved tab card, an Ask Tabs
 * source/search result, search-enter, "open selected", etc).
 *
 * By default this reuses the browser tab TabDump itself is running in —
 * navigating it to `url` — instead of opening a new one, so clicking a saved
 * tab replaces TabDump with that page rather than piling up another tab.
 * If a tab already showing `url` exists elsewhere (extension-connected
 * only), that existing tab is activated instead, so we never leave a
 * duplicate open. Pass `{ newTab: true }` for flows that can't reuse the
 * current tab because they open more than one url at once (e.g. "open
 * selected") — those always get a brand-new tab per url, exactly like
 * before this behavior existed.
 *
 * When the extension is connected, the reuse/dedupe logic above runs there
 * (it's the only side with chrome.tabs access) — see
 * extension/src/browser-actions.js's openUrl. Otherwise, or if the
 * extension call fails for any reason, this falls back to plain browser
 * navigation: `window.location.assign` to reuse the current tab, or
 * `window.open` for `newTab`.
 */
export async function openTab(url: string, options?: { newTab?: boolean }): Promise<void> {
  const reuseCurrentTab = options?.newTab !== true

  if (isBrowserConnected()) {
    const res = await sendBrowserCommand<
      { url: string; reuseCurrentTab: boolean },
      { tab: BrowserTabInfo; alreadyOpen: boolean }
    >("open_url", { url, reuseCurrentTab })
    if (res.ok) {
      if (res.result.alreadyOpen) {
        toast.info("Already open", { description: "Taking you to the existing tab…" })
      }
      return
    }
  }

  if (reuseCurrentTab) {
    window.location.assign(url)
    return
  }

  window.open(url, "_blank", "noopener,noreferrer")
}
