import { sendBrowserCommand } from "./bridge"
import type { BrowserContextSnapshot, BrowserTabInfo, BrowserWindowInfo } from "./protocol"

export type { BrowserContextSnapshot }

const CONTEXT_FETCH_TIMEOUT_MS = 4000

/**
 * Returns `null` (never throws) when the extension doesn't answer in time —
 * callers should treat that exactly like "not connected" rather than a hard
 * error, since a slow/missing extension shouldn't block the rest of a
 * question that may not even need browser data.
 *
 * `timeoutMs` defaults to the Ask Tabs use case's generous budget; callers on
 * a tighter budget (e.g. title resolution, which must not stall a paste of
 * ordinary URLs just because one of them happens to be a Google Doc) can pass
 * something shorter.
 */
export async function fetchBrowserContext(timeoutMs: number = CONTEXT_FETCH_TIMEOUT_MS): Promise<BrowserContextSnapshot | null> {
  const [tabsResult, windowsResult] = await Promise.all([
    sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs }),
    sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs }),
  ])

  if (!tabsResult.ok || !windowsResult.ok) return null

  const tabs = tabsResult.result.tabs
  const activeTab = tabs.find((t) => t.active)

  return { tabs, windows: windowsResult.result.windows, activeTabId: activeTab?.tabId ?? null }
}
