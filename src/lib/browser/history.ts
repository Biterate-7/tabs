import { isDesktop } from "@/lib/platform/detect"
import { sendBrowserCommand } from "./bridge"
import { askChromeForHistory } from "./desktop-relay"
import { DESKTOP_UNREACHABLE } from "./protocol"
import type { HistoryVisitItem } from "./protocol"

export type { HistoryVisitItem }

/**
 * History scans can legitimately take longer than the bridge's normal
 * default (chrome.history.search over a 30-day range, thousands of entries)
 * — generous, but still bounded so a hung extension can't leave History
 * Dump's scan stage spinning forever.
 */
const HISTORY_FETCH_TIMEOUT_MS = 15000

export type FetchHistoryResult =
  | { ok: true; items: HistoryVisitItem[] }
  | { ok: false; reason: "not-connected" | "error"; error?: string }

/**
 * Requests raw browser history in `[startTime, endTime]` (epoch ms) from the
 * extension via the same typed command bridge every other browser-read
 * action uses (see fetchBrowserContext) — never throws, and distinguishes
 * "the extension isn't there to ask" from "it answered with an error" so the
 * History Dump UI can show the right message (AGENTS.md section 17/20)
 * instead of a generic failure.
 */
export async function fetchBrowserHistory(
  startTime: number,
  endTime?: number,
  maxResults?: number
): Promise<FetchHistoryResult> {
  // Hubble Desktop can't call the extension; it asks through the browser,
  // where the person approves sending this range (./desktop-relay.ts).
  if (isDesktop()) {
    const outcome = await askChromeForHistory({ startTime, ...(endTime !== undefined ? { endTime } : {}), ...(maxResults !== undefined ? { maxResults } : {}) })
    return outcome.ok ? { ok: true, items: outcome.result.items } : { ok: false, reason: "error", error: outcome.error }
  }

  const result = await sendBrowserCommand<
    { startTime: number; endTime?: number; maxResults?: number },
    { items: HistoryVisitItem[] }
  >("get_history", { startTime, endTime, maxResults }, { timeoutMs: HISTORY_FETCH_TIMEOUT_MS })

  if (!result.ok) {
    const notConnected = result.error === DESKTOP_UNREACHABLE || /timed out|extension-unreachable/i.test(result.error)
    return notConnected ? { ok: false, reason: "not-connected" } : { ok: false, reason: "error", error: result.error }
  }

  return { ok: true, items: result.result.items }
}
