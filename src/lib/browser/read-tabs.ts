import { isDesktop } from "@/lib/platform/detect"
import { sendBrowserCommand } from "./bridge"
import { askChromeForTabs } from "./desktop-relay"
import type { BrowserTabInfo, BrowserWindowInfo } from "./protocol"

/**
 * The tabs and windows open in Chrome, for something the person just asked
 * to do with them (Save current session, Organize open tabs, Add → Browser
 * tabs). One reading for both shells:
 *
 * - Hubble on the web asks Hubble for Chrome through the page, as it always has.
 * - Hubble Desktop asks through the browser (./desktop-relay.ts): a Hubble
 *   page opens, and nothing is read until the person presses Send there.
 *
 * `selfOrigin` is the origin of Hubble's own tabs, which callers leave out.
 */
export type ChromeTabsReading =
  /**
   * `windows` is null when the tabs came back but the window list didn't: a
   * caller that must leave private windows out reads nothing then.
   */
  | { ok: true; tabs: BrowserTabInfo[]; windows: BrowserWindowInfo[] | null; selfOrigin: string }
  | { ok: false; reason: "unavailable" | "declined" | "failed"; message?: string }

export async function readChromeTabs(timeoutMs = 2500): Promise<ChromeTabsReading> {
  if (isDesktop()) {
    const outcome = await askChromeForTabs()
    if (!outcome.ok) return { ok: false, reason: outcome.reason === "declined" ? "declined" : "failed", message: outcome.error }
    const origin = outcome.result.origin
    return { ok: true, tabs: outcome.result.tabs, windows: outcome.result.windows, selfOrigin: typeof origin === "string" ? origin : "" }
  }
  const [tabs, windows] = await Promise.all([
    sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs }),
    sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs }),
  ])
  if (!tabs.ok) return { ok: false, reason: "unavailable" }
  const list = windows.ok && Array.isArray(windows.result?.windows) ? windows.result.windows : null
  return { ok: true, tabs: tabs.result.tabs, windows: list, selfOrigin: window.location.origin }
}

/** What to say while waiting for that reading. */
export function readingChromeMessage(desktop: boolean): string {
  return desktop
    ? "Waiting for Chrome. A Hubble page opened in your browser: press Send there to share the tabs you have open."
    : "Reading the tabs open in Chrome…"
}
