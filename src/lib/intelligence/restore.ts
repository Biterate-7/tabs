"use client"

import { sendBrowserCommand } from "@/lib/browser/bridge"
import { resourceKey } from "@/lib/resources/url"
import type { BrowserTabInfo } from "@/lib/browser/protocol"
import type { RestoreTab } from "@/lib/sessions/restore"

/**
 * Resume reopens only what isn't already open: each tab is compared with
 * Chrome's open tabs by source identity (resourceKey — www, tracking
 * parameters and a trailing slash don't make a page different). If Chrome
 * can't be asked, nothing is filtered: opening a duplicate is better than
 * silently skipping a tab the person wanted.
 */
export function withoutOpen(tabs: readonly RestoreTab[], open: readonly Pick<BrowserTabInfo, "url">[]): RestoreTab[] {
  const openKeys = new Set(open.map((tab) => resourceKey(tab.url)).filter((key): key is string => key !== undefined))
  const seen = new Set<string>()
  return tabs.filter((tab) => {
    const key = resourceKey(tab.url)
    if (!key) return false
    if (openKeys.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function tabsNotYetOpen(tabs: readonly RestoreTab[]): Promise<{ tabs: RestoreTab[]; alreadyOpen: number }> {
  const answer = await sendBrowserCommand<{ windowId?: number }, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {})
  if (!answer.ok || !Array.isArray(answer.result?.tabs)) return { tabs: [...tabs], alreadyOpen: 0 }
  const remaining = withoutOpen(tabs, answer.result.tabs)
  return { tabs: remaining, alreadyOpen: tabs.length - remaining.length }
}
