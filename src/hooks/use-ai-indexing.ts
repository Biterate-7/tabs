"use client"

import { useEffect, useRef, useState } from "react"
import type { Tab } from "@/lib/tabs/types"
import { indexWorkspace } from "@/lib/ai/indexer"

export type AiIndexState = { isIndexing: boolean; indexed: number; total: number }

/**
 * Background-indexes the current workspace's tabs whenever they change,
 * mirroring useTitleResolution's "fire and forget, patch progress back in"
 * shape. `runIdRef` guards against a stale run's progress callbacks landing
 * after a newer run has started (e.g. the user switches workspaces mid-index).
 *
 * `enabled` gates the whole effect: indexing embeds every candidate tab via
 * Gemini (see indexer.ts), so it only actually runs once something that
 * needs the resulting semantic index — Ask TabDump or a collection AI
 * action — has actually been opened, rather than unconditionally for every
 * user on every workspace view. This is the difference between "AI is a
 * fallback" and "AI runs whether or not anyone asked for it." Toggling
 * `enabled` back off does not clear whatever was already indexed — it just
 * stops starting new runs.
 */
export function useAiIndexing(workspaceId: string, tabs: Tab[], enabled: boolean): AiIndexState {
  const [state, setState] = useState<AiIndexState>({ isIndexing: false, indexed: 0, total: 0 })
  const runIdRef = useRef(0)

  useEffect(() => {
    if (!enabled) return

    const runId = ++runIdRef.current
    // Kicking off a background sync with an external system (IndexedDB +
    // network) on tabs change — not state derived from props/state, so this
    // doesn't fit the derived-state anti-pattern the rule guards against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ isIndexing: true, indexed: 0, total: 0 })

    indexWorkspace(workspaceId, tabs, (progress) => {
      if (runIdRef.current !== runId) return
      setState({ isIndexing: true, ...progress })
    }).then(() => {
      if (runIdRef.current !== runId) return
      setState((prev) => ({ ...prev, isIndexing: false }))
    })
  }, [workspaceId, tabs, enabled])

  return state
}
