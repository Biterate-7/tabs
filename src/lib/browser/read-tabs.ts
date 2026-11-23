import { desktopExtensionLink } from "@/lib/platform/desktop"
import { isDesktop } from "@/lib/platform/detect"
import { sendBrowserCommand } from "./bridge"
import { DESKTOP_UNREACHABLE } from "./protocol"
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
  /**
   * No Hubble for Chrome answered. `cause` says why, and `message` says it in
   * words the person can act on:
   *  - "not-paired": Hubble Desktop has no connected Hubble for Chrome. Pairing
   *    starts from the extension's popup (Connect), so that is what to do.
   *  - "no-answer": one is connected, but Chrome never collected the request
   *    (closed, or the extension is turned off).
   *  - "no-extension": on the web, no extension answered the page.
   */
  | { ok: false; reason: "unavailable"; cause: ChromeUnavailableCause; message: string }
  | { ok: false; reason: "declined" | "failed"; message?: string }

export type ChromeUnavailableCause = "not-paired" | "no-answer" | "no-extension"

/** What to say when no Hubble for Chrome answers. */
export const CHROME_NOT_CONNECTED_MESSAGE = "Hubble for Chrome didn't answer. Open Chrome, or connect it in Settings → Chrome extension."
/** Hubble Desktop has no paired Hubble for Chrome: every request to Chrome is refused until it is connected. */
export const CHROME_NOT_PAIRED_MESSAGE =
  "Hubble for Chrome isn't connected to Hubble Desktop yet. In Chrome, click the Hubble icon in the toolbar and choose Connect, then try again. Nothing was read."
/** Paired, but Chrome never picked the request up. */
export const CHROME_NO_ANSWER_MESSAGE =
  "Hubble for Chrome is connected, but Chrome didn't answer. Open Chrome with Hubble for Chrome turned on, then try again. Nothing was read."
/** Chrome picked the request up and didn't finish in time. */
export const CHROME_SLOW_MESSAGE = "Chrome didn't finish sending your tabs in time. Try again. Nothing was read."

const TIMED_OUT = /timed out/i

export async function readChromeTabs(timeoutMs = 2500): Promise<ChromeTabsReading> {
  const [tabs, windows] = await Promise.all([
    sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs }),
    sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs }),
  ])
  if (!tabs.ok) {
    const reading = await explainFailure(tabs.error)
    // Codes and Hubble's own wording only: never an address or a title.
    console.warn("[hubble] reading Chrome's tabs failed", { reason: reading.reason, ...("cause" in reading ? { cause: reading.cause } : {}), error: tabs.error })
    return reading
  }
  if (!Array.isArray(tabs.result?.tabs)) return { ok: false, reason: "failed", message: "Chrome's answer couldn't be read." }
  const list = windows.ok && Array.isArray(windows.result?.windows) ? windows.result.windows : null
  return { ok: true, tabs: tabs.result.tabs, windows: list, selfOrigin: typeof window === "undefined" ? "" : window.location.origin }
}

/**
 * Why `list_browser_tabs` failed, as a reading. On the web every failure
 * means "no extension". In Hubble Desktop the link tells them apart: the
 * bridge reports "not paired" and "never collected" both as
 * DESKTOP_UNREACHABLE, so the pairing itself is asked to decide between them.
 */
async function explainFailure(error: string): Promise<Extract<ChromeTabsReading, { ok: false }>> {
  if (!isDesktop()) return { ok: false, reason: "unavailable", cause: "no-extension", message: CHROME_NOT_CONNECTED_MESSAGE }
  if (error === DESKTOP_UNREACHABLE) {
    const paired = await desktopExtensionLink.paired().catch(() => false)
    return paired
      ? { ok: false, reason: "unavailable", cause: "no-answer", message: CHROME_NO_ANSWER_MESSAGE }
      : { ok: false, reason: "unavailable", cause: "not-paired", message: CHROME_NOT_PAIRED_MESSAGE }
  }
  if (TIMED_OUT.test(error)) return { ok: false, reason: "failed", message: CHROME_SLOW_MESSAGE }
  // Hubble for Chrome answered and refused (an argument it rejected, a Chrome API that failed).
  return { ok: false, reason: "failed", message: `Hubble for Chrome couldn't read your tabs: ${error}` }
}

/** What to say while waiting for that reading. */
export function readingChromeMessage(desktop: boolean): string {
  return desktop ? "Asking Chrome for your open tabs…" : "Reading the tabs open in Chrome…"
}
