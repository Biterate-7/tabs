import { sendBrowserCommand } from "./bridge"
import type { BrowserTabInfo, BrowserWindowInfo } from "./protocol"

/**
 * The tabs and windows open in Chrome, for something the person just asked
 * to do with them (Save current session, Organize open tabs, Add → Browser
 * tabs). Hubble Desktop asks the paired Hubble for Chrome (./bridge.ts, over
 * the link in src-tauri/src/extension_link.rs); nothing goes through a website.
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

/** What to say when no Hubble for Chrome answers. */
export const CHROME_NOT_CONNECTED_MESSAGE = "Hubble for Chrome didn't answer. Open Chrome, or connect it in Settings → Chrome extension."

export async function readChromeTabs(timeoutMs = 2500): Promise<ChromeTabsReading> {
  const [tabs, windows] = await Promise.all([
    sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs }),
    sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs }),
  ])
  // Any failure reads as "not there": the dialogs then say how to connect Hubble for Chrome and offer Try again.
  if (!tabs.ok) return { ok: false, reason: "unavailable", message: CHROME_NOT_CONNECTED_MESSAGE }
  if (!Array.isArray(tabs.result?.tabs)) return { ok: false, reason: "failed", message: "Chrome's answer couldn't be read." }
  const list = windows.ok && Array.isArray(windows.result?.windows) ? windows.result.windows : null
  return { ok: true, tabs: tabs.result.tabs, windows: list, selfOrigin: typeof window === "undefined" ? "" : window.location.origin }
}

/** What to say while waiting for that reading. */
export function readingChromeMessage(desktop: boolean): string {
  return desktop ? "Asking Chrome for your open tabs…" : "Reading the tabs open in Chrome…"
}
