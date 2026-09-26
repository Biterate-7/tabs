"use client"

import { useEffect, useMemo, useState } from "react"
import {
  addDependency,
  removeDependency,
  updateDependencyType,
} from "@/lib/dependencies/relations"
import { createTimestamp } from "@/lib/timestamps"
import { publishSyncDirty, subscribeRemoteEntities } from "@/lib/sync/notify"
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
 * (WorkspaceView and GraphView both need it) because Hubble only ever
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

  // Dependencies the engine pulled from the server. Applied through this
  // hook rather than written to localStorage by the engine, because this
  // hook is the single writer of that key — the effect above would otherwise
  // clobber the engine's write with stale React state.
  //
  // Deliberately does NOT publish a dirty event: the value came from the
  // server, and re-marking it would push it straight back.
  useEffect(
    () =>
      subscribeRemoteEntities((event) => {
        if (!event.dependencies) return
        setDependencies(event.dependencies as TabDependency[])
      }),
    []
  )

  return useMemo(() => {
    /**
     * Announces a changed dependency to the sync engine.
     *
     * A dependency's identity is its (parentTabId, childTabId) pair — the id
     * is derived from it, never minted — so that is what travels. The
     * remove/retype actions take an id, so the pair is looked up in current
     * state before the mutation; afterwards the row is gone and the pair
     * would be unrecoverable.
     *
     * Called from action handlers, never inside a `setDependencies` updater.
     */
    const publishDependency = (id: string, deleted: boolean) => {
      const found = dependencies.find((d) => d.id === id)
      if (!found) return
      publishSyncDirty([
        {
          entityType: "dependency",
          parentTabId: found.parentTabId,
          childTabId: found.childTabId,
          deleted,
        },
      ])
    }

    return {
      dependencies,
      setDependencies,
      // The clock is read here, once, where the user's mutation actually
      // happens — then passed in. Letting the reducer default it would move
      // the read inside the updater, which React may evaluate more than once
      // (twice per update under StrictMode), minting a timestamp that is then
      // discarded. The updater itself stays a pure reducer call so React's
      // "apply to the latest state" semantics are preserved.
      addDependency: (parentTabId: string, childTabId: string, type?: DependencyType) => {
        const now = createTimestamp()
        setDependencies((prev) => addDependency(prev, parentTabId, childTabId, type, now, now))
        // The pair is known directly here, so no lookup is needed — and a
        // brand-new dependency is not in `dependencies` yet anyway.
        publishSyncDirty([{ entityType: "dependency", parentTabId, childTabId, deleted: false }])
      },
      removeDependency: (id: string) => {
        // Published BEFORE the mutation: afterwards the row is gone and its
        // pair — the only identity a dependency has — could not be recovered.
        publishDependency(id, true)
        setDependencies((prev) => removeDependency(prev, id))
      },
      updateDependencyType: (id: string, type: DependencyType | undefined) => {
        const now = createTimestamp()
        setDependencies((prev) => updateDependencyType(prev, id, type, now))
        publishDependency(id, false)
      },
    }
  }, [dependencies])
}
