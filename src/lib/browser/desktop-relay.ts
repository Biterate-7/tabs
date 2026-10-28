import { desktopChromeRelay } from "@/lib/platform/desktop"
import type { BrowserTabInfo, BrowserWindowInfo, HistoryVisitItem } from "./protocol"

/**
 * Hubble Desktop asking Chrome a question: which tabs are open, or what was
 * visited in a range. The app can't reach Chrome and Hubble for Chrome can't
 * be called, so the question goes through the person's browser — a Hubble
 * page shows what is asked, the person presses Send, and the extension hands
 * the answer back over the loopback bridge (src-tauri/src/import_bridge.rs,
 * "The relay"; src/components/desktop-relay).
 *
 * Opt-in by design: only something the person just asked for calls this
 * (Save current session, a history scan), because each call opens a browser
 * tab. Nothing reads Chrome in the background from the desktop app.
 */

export type RelayOutcome<T> =
  | { ok: true; result: T }
  /** `declined`: the person pressed Don't send. `timeout`: nobody answered. */
  | { ok: false; reason: "declined" | "timeout" | "failed"; error: string }

/** Long enough to switch to the browser, read the page and decide. */
export const RELAY_WAIT_MS = 4 * 60 * 1000
const POLL_MS = 1500
export const DECLINED_MESSAGE = "Not sent from Chrome."

async function ask<T>(action: "browser_tabs" | "history", args: Record<string, unknown>, waitMs = RELAY_WAIT_MS): Promise<RelayOutcome<T>> {
  let id: string
  try {
    id = await desktopChromeRelay.begin(action, args)
  } catch (error) {
    return { ok: false, reason: "failed", error: typeof error === "string" ? error : "Couldn't open your browser." }
  }

  return new Promise<RelayOutcome<T>>((resolve) => {
    let settled = false
    let unlisten: (() => void) | undefined
    const finish = (outcome: RelayOutcome<T>) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      unlisten?.()
      resolve(outcome)
    }
    const check = async () => {
      const answer = await desktopChromeRelay.take(id).catch(() => null)
      if (!answer) return
      if (answer.ok) finish({ ok: true, result: answer.result as T })
      else finish({ ok: false, reason: answer.error === DECLINED_MESSAGE ? "declined" : "failed", error: answer.error })
    }
    // The event is the fast path; the poll covers an event missed while the
    // listener was still being attached.
    void desktopChromeRelay.onDelivered((delivered) => delivered === id && void check()).then((stop) => (settled ? stop() : (unlisten = stop)))
    const poll = setInterval(() => void check(), POLL_MS)
    const timer = setTimeout(() => {
      void desktopChromeRelay.cancel(id).catch(() => {})
      finish({ ok: false, reason: "timeout", error: "Chrome didn't answer. Approve the request in your browser, then try again." })
    }, waitMs)
  })
}

/**
 * Chrome's open tabs and windows, in one approval. `origin` is the relay
 * page's own (Hubble's site), so its tabs can be left out as Hubble's own
 * are on the web.
 */
export type ChromeTabsSnapshot = { tabs: BrowserTabInfo[]; windows: BrowserWindowInfo[]; origin?: string }

export function askChromeForTabs(): Promise<RelayOutcome<ChromeTabsSnapshot>> {
  return ask<ChromeTabsSnapshot>("browser_tabs", {}).then((outcome) =>
    outcome.ok && (!Array.isArray(outcome.result?.tabs) || !Array.isArray(outcome.result?.windows))
      ? { ok: false, reason: "failed", error: "Chrome sent something unexpected." }
      : outcome
  )
}

/** Chrome's history in `[startTime, endTime]`. */
export function askChromeForHistory(args: { startTime: number; endTime?: number; maxResults?: number }): Promise<RelayOutcome<{ items: HistoryVisitItem[] }>> {
  return ask<{ items: HistoryVisitItem[] }>("history", args).then((outcome) =>
    outcome.ok && !Array.isArray(outcome.result?.items) ? { ok: false, reason: "failed", error: "Chrome sent something unexpected." } : outcome
  )
}
