"use client"

import { useEffect, useRef } from "react"
import type { Tab } from "@/lib/tabs/types"
import { getCachedTitle, recordFailure, recordSuccess, shouldSkipResolution } from "@/lib/titles/client/cache"
import { requestTitles } from "@/lib/titles/client/queue"
import { isGoogleDocsHostname } from "@/lib/titles/google-docs-host"
import { fetchBrowserContext } from "@/lib/browser/context"
import { normalizeUrl } from "@/lib/tabs/normalize"

// Short relative to fetchBrowserContext's own default: the extension, when
// present, answers a same-page postMessage round trip in single-digit
// milliseconds, so this only matters (and only costs anything) when it's
// absent or unreachable — which must never meaningfully delay resolving an
// ordinary pasted URL just because it happens to be a Google Doc.
const BROWSER_TAB_LOOKUP_TIMEOUT_MS = 800

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * The server-side Google Docs resolver can only ever see what an anonymous
 * fetch sees — for any non-public document that's Google's sign-in wall (see
 * server/resolvers/google-docs.ts), which is correctly reported as
 * unresolved rather than mislabeled with the login page's title. But if the
 * TabDump browser extension is connected and the user already has that exact
 * document open as a real tab, `chrome.tabs` already knows its real title —
 * no auth, no fetch, no scraping needed. This checks that, for Google Docs
 * URLs only, before falling through to the normal server-side path.
 */
async function matchOpenBrowserTabTitles(normalizedUrls: string[]): Promise<Map<string, string>> {
  const matches = new Map<string, string>()
  const context = await fetchBrowserContext(BROWSER_TAB_LOOKUP_TIMEOUT_MS)
  if (!context) return matches

  const titleByNormalizedUrl = new Map<string, string>()
  for (const tab of context.tabs) {
    const title = tab.title?.trim()
    if (!title) continue
    try {
      titleByNormalizedUrl.set(normalizeUrl(new URL(tab.url)), title)
    } catch {
      // Not a parseable URL — can't match any candidate anyway.
    }
  }

  for (const url of normalizedUrls) {
    const title = titleByNormalizedUrl.get(url)
    if (title) matches.set(url, title)
  }

  return matches
}

/**
 * Drives asynchronous title resolution for `tabs`, patching results back
 * through `onResolved` (which callers wire to their existing tabs-update
 * path — no separate persistence or state model needed, since resolved
 * titles ride the same channel every other tab mutation already uses).
 *
 * A tab is only ever attempted once per mount (tracked in `attemptedRef`),
 * so re-renders triggered by the very act of patching titles in don't cause
 * repeat requests. Cache hits are applied synchronously with no network
 * call at all.
 */
export function useTitleResolution(tabs: Tab[], onResolved: (tabs: Tab[]) => void) {
  const attemptedRef = useRef<Set<string>>(new Set())
  const onResolvedRef = useRef(onResolved)
  // Deliberate "latest ref" idiom: this write is a same-render snapshot
  // assignment, not a state mutation read back during this render, so it
  // can't cause the divergent-render bug the rule guards against.
  // eslint-disable-next-line react-hooks/refs
  onResolvedRef.current = onResolved

  useEffect(() => {
    let cacheChanged = false
    const withCacheHits = tabs.map((tab) => {
      if (tab.title) return tab
      const cached = getCachedTitle(tab.normalizedUrl)
      if (!cached) return tab
      cacheChanged = true
      return { ...tab, title: cached.title }
    })
    if (cacheChanged) onResolvedRef.current(withCacheHits)

    const candidates = withCacheHits.filter(
      (tab) =>
        !tab.title &&
        !attemptedRef.current.has(tab.normalizedUrl) &&
        !shouldSkipResolution(tab.normalizedUrl)
    )
    if (candidates.length === 0) return

    const urls = Array.from(new Set(candidates.map((tab) => tab.normalizedUrl)))
    for (const url of urls) attemptedRef.current.add(url)

    const googleDocsUrls = urls.filter((url) => {
      const hostname = hostnameOf(url)
      return hostname !== null && isGoogleDocsHostname(hostname)
    })

    async function resolve() {
      const browserTabMatches =
        googleDocsUrls.length > 0 ? await matchOpenBrowserTabTitles(googleDocsUrls) : new Map<string, string>()

      let resolvedChanged = false
      let next = withCacheHits

      if (browserTabMatches.size > 0) {
        next = next.map((tab) => {
          const title = browserTabMatches.get(tab.normalizedUrl)
          if (!title) return tab
          recordSuccess(tab.normalizedUrl, title, "browser-tab")
          resolvedChanged = true
          return { ...tab, title }
        })
      }

      const remainingUrls = urls.filter((url) => !browserTabMatches.has(url))
      if (remainingUrls.length > 0) {
        const results = await requestTitles(remainingUrls)
        const byUrl = new Map(results.map((result) => [result.url, result]))

        next = next.map((tab) => {
          const result = byUrl.get(tab.normalizedUrl)
          if (!result) return tab

          if (result.ok) {
            recordSuccess(tab.normalizedUrl, result.title, result.source)
            resolvedChanged = true
            return { ...tab, title: result.title }
          }

          recordFailure(tab.normalizedUrl, result.permanent)
          return tab
        })
      }

      if (resolvedChanged) onResolvedRef.current(next)
    }

    resolve()
  }, [tabs])
}
