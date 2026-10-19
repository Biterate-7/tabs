import { isSafeOpenUrl } from "@/lib/browser/protocol"
import { formatDate } from "@/lib/time-format"
import { cleanSessionName } from "./model"
import type { BrowserTabInfo, BrowserWindowInfo } from "@/lib/browser/protocol"
import type { CapturedTab } from "./types"

/**
 * Reading what to save from Chrome's own tab list (Hubble for Chrome's
 * `list_browser_tabs` / `list_browser_windows`), on this page.
 *
 * Only ordinary windows: a private (incognito) window's tabs are never
 * saved, and when the window list could not be read nothing is — there would
 * be no way to tell a private window's tabs apart.
 */

/** One Chrome window the person can choose to save. */
export type CapturableWindow = {
  windowId: number
  focused: boolean
  /** Its tabs Hubble can save, in tab-strip order. */
  tabs: CapturedTab[]
  /** Browser pages (chrome://, the Web Store, new tabs) that can't be reopened and are left out. */
  skipped: number
  /** What the window is about, for a list: its active tab's title. */
  label: string
}

/**
 * The ordinary windows and what each would save. Hubble's own tabs
 * (`selfOrigin`) are left out without being counted: resuming happens from
 * Hubble, so a saved copy of it would only open a second one.
 */
export function capturableWindows(
  tabs: readonly BrowserTabInfo[],
  windows: readonly BrowserWindowInfo[],
  selfOrigin: string
): CapturableWindow[] {
  // Popups and app windows are not where work is open; only normal ones are offered.
  const normal = windows.filter((win) => !win.incognito && (!win.type || win.type === "normal"))
  const out: CapturableWindow[] = []
  for (const win of normal) {
    const own = tabs.filter((tab) => tab.windowId === win.windowId).sort((a, b) => a.index - b.index)
    const kept: CapturedTab[] = []
    let skipped = 0
    let label = ""
    for (const tab of own) {
      if (sameOrigin(tab.url, selfOrigin)) continue
      if (!isSafeOpenUrl(tab.url)) {
        skipped += 1
        continue
      }
      kept.push({
        url: tab.url,
        ...(tab.title ? { title: tab.title } : {}),
        ...(tab.favIconUrl ? { favicon: tab.favIconUrl } : {}),
        ...(tab.pinned ? { pinned: true } : {}),
      })
      if (tab.active && tab.title) label = tab.title
    }
    if (kept.length === 0 && skipped === 0) continue
    out.push({ windowId: win.windowId, focused: win.focused, tabs: kept, skipped, label: label || kept[0]?.title || "" })
  }
  // The window the person is in first; then Chrome's own order.
  return out.sort((a, b) => Number(b.focused) - Number(a.focused))
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** The tabs of the chosen windows, window by window, each in tab-strip order. */
export function tabsOfWindows(windows: readonly CapturableWindow[], chosen: ReadonlySet<number>): { tabs: CapturedTab[]; skipped: number } {
  const picked = windows.filter((win) => chosen.has(win.windowId))
  return { tabs: picked.flatMap((win) => win.tabs), skipped: picked.reduce((sum, win) => sum + win.skipped, 0) }
}

/**
 * A name for a session the person didn't name: the project's when one was
 * chosen, otherwise "Session", with the day — "History IA — 19 Oct". No AI.
 */
export function suggestSessionName(options: { projectName?: string; now: number }): string {
  const base = cleanSessionName(options.projectName) || "Session"
  return cleanSessionName(`${base} — ${formatDate(options.now, options.now)}`)
}
