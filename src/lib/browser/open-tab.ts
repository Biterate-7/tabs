"use client"

import { toast } from "sonner"
import { isDesktop, openExternal } from "@/lib/platform"
import { isBrowserConnected, sendBrowserCommand } from "./bridge"
import type { BrowserTabInfo } from "./protocol"

/**
 * Opens a URL the user clicked on in TabDump (a saved tab card, an Ask Tabs
 * source/search result, search-enter, "open selected", etc).
 *
 * On the desktop app this always hands the URL to the user's default
 * browser and stops there. That is a deliberate product boundary, not a
 * limitation: the web behaviour below reuses the tab TabDump is running in,
 * and doing the equivalent on desktop would navigate the application window
 * to somebody else's website — turning TabDump into a bad browser and
 * leaving no way back to the workspace. A saved tab belongs in the browser
 * the user actually chose. (src-tauri/src/lib.rs additionally refuses any
 * navigation away from the app origin, so a link that never reaches this
 * function still cannot strand the window.)
 *
 * On the web, by default this reuses the browser tab TabDump itself is
 * running in — navigating it to `url` — instead of opening a new one, so
 * clicking a saved tab replaces TabDump with that page rather than piling up
 * another tab. If a tab already showing `url` exists elsewhere
 * (extension-connected only), that existing tab is activated instead, so we
 * never leave a duplicate open. Pass `{ newTab: true }` for flows that can't
 * reuse the current tab because they open more than one url at once (e.g.
 * "open selected") — those always get a brand-new tab per url, exactly like
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
  if (isDesktop()) {
    await openExternal(url)
    return
  }

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
