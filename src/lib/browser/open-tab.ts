"use client"

import { toast } from "sonner"
import { isBrowserConnected, sendBrowserCommand } from "./bridge"
import type { BrowserTabInfo } from "./protocol"

/**
 * Opens a URL the user clicked on in TabDump (a saved tab card, "Open
 * selected", search-enter, etc). When the extension is connected, this
 * routes through it so a tab already showing that URL gets activated
 * instead of duplicated — otherwise, or if the extension call fails for any
 * reason, it falls back to a plain `window.open`, exactly like before this
 * behavior existed.
 */
export async function openTab(url: string): Promise<void> {
  if (isBrowserConnected()) {
    const res = await sendBrowserCommand<{ url: string }, { tab: BrowserTabInfo; alreadyOpen: boolean }>("open_url", {
      url,
    })
    if (res.ok) {
      if (res.result.alreadyOpen) {
        toast.info("Already open", { description: "Taking you to the existing tab…" })
      }
      return
    }
  }

  window.open(url, "_blank", "noopener,noreferrer")
}
