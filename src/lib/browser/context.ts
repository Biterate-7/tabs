import { sendBrowserCommand } from "./bridge"
import type { BrowserContextSnapshot, BrowserTabInfo, BrowserWindowInfo } from "./protocol"

export type { BrowserContextSnapshot }

const CONTEXT_FETCH_TIMEOUT_MS = 4000

/**
 * Returns `null` (never throws) when the extension doesn't answer in time —
 * callers should treat that exactly like "not connected" rather than a hard
 * error, since a slow/missing extension shouldn't block the rest of a
 * question that may not even need browser data.
 */
export async function fetchBrowserContext(): Promise<BrowserContextSnapshot | null> {
  const [tabsResult, windowsResult] = await Promise.all([
    sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs: CONTEXT_FETCH_TIMEOUT_MS }),
    sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs: CONTEXT_FETCH_TIMEOUT_MS }),
  ])

  if (!tabsResult.ok || !windowsResult.ok) return null

  const tabs = tabsResult.result.tabs
  const activeTab = tabs.find((t) => t.active)

  return { tabs, windows: windowsResult.result.windows, activeTabId: activeTab?.tabId ?? null }
}
