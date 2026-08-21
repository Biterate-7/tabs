"use client"

import { useEffect, useRef } from "react"
import type { Tab } from "@/lib/tabs/types"
import { getCachedTitle, recordFailure, recordSuccess, shouldSkipResolution } from "@/lib/titles/client/cache"
import { requestTitles } from "@/lib/titles/client/queue"

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

    requestTitles(urls).then((results) => {
      const byUrl = new Map(results.map((result) => [result.url, result]))
      let resolvedChanged = false

      const next = withCacheHits.map((tab) => {
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

      if (resolvedChanged) onResolvedRef.current(next)
    })
  }, [tabs])
}
