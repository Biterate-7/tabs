"use client"

import { useMemo, useState } from "react"
import { loadGraphState, saveGraphState } from "@/lib/graph/persistence"
import { createTimestamp } from "@/lib/timestamps"
import type { ManualConnection } from "@/lib/graph/types"

/**
 * The links a person draws between two saved tabs ("these belong
 * together"), as the Graph shows and edits them.
 *
 * They live where they always have — the `manualConnections` of the saved
 * tab-graph state (lib/graph/persistence.ts) — because the tab peek and the
 * context resolver read them from there too, and moving them would orphan
 * every link made before the Tab map became part of the Graph. Each write
 * reads that record fresh and changes only its links, so nothing else kept
 * in it is touched.
 *
 * Links whose tabs are gone are hidden here, not deleted: a tab removed by
 * mistake and restored with Undo comes back with its links.
 */
export function useTabLinks(validTabIds: ReadonlySet<string>) {
  const [raw, setRaw] = useState<ManualConnection[]>(() => (typeof window === "undefined" ? [] : loadGraphState().manualConnections))

  const links = useMemo(() => raw.filter((link) => validTabIds.has(link.a) && validTabIds.has(link.b)), [raw, validTabIds])

  return useMemo(() => {
    const same = (link: ManualConnection, a: string, b: string) => (link.a === a && link.b === b) || (link.a === b && link.b === a)
    return {
      links,
      /**
       * False when there was nothing to add: the same tab, or already linked.
       * Checked against the stored record, not this render's copy, so an
       * Undo held by a toast still works after the link it restores is gone.
       */
      add: (a: string, b: string): boolean => {
        const state = loadGraphState()
        if (a === b || state.manualConnections.some((link) => same(link, a, b))) return false
        const manualConnections = [...state.manualConnections, { a, b, createdAt: createTimestamp() }]
        saveGraphState({ ...state, manualConnections })
        setRaw(manualConnections)
        return true
      },
      remove: (a: string, b: string) => {
        const state = loadGraphState()
        const manualConnections = state.manualConnections.filter((link) => !same(link, a, b))
        saveGraphState({ ...state, manualConnections })
        setRaw(manualConnections)
      },
    }
  }, [links])
}
