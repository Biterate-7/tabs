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
 */
export function useAiIndexing(workspaceId: string, tabs: Tab[]): AiIndexState {
  const [state, setState] = useState<AiIndexState>({ isIndexing: false, indexed: 0, total: 0 })
  const runIdRef = useRef(0)

  useEffect(() => {
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
  }, [workspaceId, tabs])

  return state
}
