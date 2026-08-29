"use client"

import { useEffect, useMemo, useState } from "react"
import {
  addDependency,
  removeDependency,
  updateDependencyType,
} from "@/lib/dependencies/relations"
import {
  defaultDependencyState,
  loadDependencyState,
  pruneDependencyState,
  saveDependencyState,
} from "@/lib/dependencies/persistence"
import type { DependencyType, TabDependency } from "@/lib/dependencies/types"

const SAVE_DEBOUNCE_MS = 400

/**
 * Loads the dependency store from localStorage once on mount and keeps it
 * saved as it changes — the same "load-once-per-mount, source of truth is
 * localStorage" pattern lib/graph/persistence.ts's consumer (GraphView)
 * already uses for graph state. Safe to use from more than one call site
 * (WorkspaceView and GraphView both need it) because TabDump only ever
 * mounts one of them at a time — see app-shell.tsx's `view` switch — so
 * there's no risk of two live copies drifting out of sync with each other.
 *
 * The returned `dependencies` is a *derived* view, pruned against
 * `validTabIds` on every read rather than by calling setState from an
 * effect — same "filter at read/save time, don't reactively rewrite state"
 * approach lib/graph/relations.ts's buildGraphEdges already uses for manual
 * connections. A tab deletion or workspace deletion is reflected here the
 * very next render, with no separate synchronization effect needed.
 */
export function useDependencyStore(validTabIds: Set<string>) {
  const [rawDependencies, setDependencies] = useState<TabDependency[]>(() => {
    if (typeof window === "undefined") return defaultDependencyState().dependencies
    return loadDependencyState().dependencies
  })

  const dependencies = useMemo(
    () => pruneDependencyState({ version: 1, dependencies: rawDependencies }, validTabIds).dependencies,
    [rawDependencies, validTabIds]
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      saveDependencyState({ version: 1, dependencies })
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [dependencies])

  return useMemo(
    () => ({
      dependencies,
      setDependencies,
      addDependency: (parentTabId: string, childTabId: string, type?: DependencyType) =>
        setDependencies((prev) => addDependency(prev, parentTabId, childTabId, type)),
      removeDependency: (id: string) => setDependencies((prev) => removeDependency(prev, id)),
      updateDependencyType: (id: string, type: DependencyType | undefined) =>
        setDependencies((prev) => updateDependencyType(prev, id, type)),
    }),
    [dependencies]
  )
}
