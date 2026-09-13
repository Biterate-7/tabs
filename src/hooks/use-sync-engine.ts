"use client"

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { SyncEngine } from "@/lib/sync/engine"
import type { SyncEngineHost } from "@/lib/sync/engine"
import { installSyncTriggers } from "@/lib/sync/triggers"
import { diffStores } from "@/lib/sync/diff"
import type { WorkspaceJournal } from "@/lib/sync/journal"
import { defaultJournal } from "@/lib/sync/journal"
import type { Collection } from "@/lib/collections/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

/**
 * The only place React and the sync engine meet.
 *
 * Deliberately thin. The engine owns scheduling, retry, cursors and
 * conflicts and knows nothing about React; this hook owns its lifetime and
 * hands the UI a subscription. Nothing here performs a request, and nothing
 * here runs inside a state updater — the Phase 2.5 rule still holds.
 */

export type SyncEngineInput = {
  userId: string | null
  store: WorkspaceStore | null
  /** Read at sync time rather than passed as arrays: these live in their own localStorage stores, not in this component. */
  getCollections: (workspaceId: string) => Collection[]
  getDependencies: () => TabDependency[]
  /** Commits a workspace that came from the server, through the app's own local seam with remote origin. */
  onRemoteWorkspace: (workspace: Workspace) => void
}

export type SyncEngineBinding = {
  /** Records a local commit. Returns immediately; never throws. */
  notifyLocalCommit(previous: WorkspaceStore | null, next: WorkspaceStore): void
  getState(workspaceId: string): WorkspaceJournal
  subscribe(listener: () => void): () => void
  syncNow(workspaceId: string): void
  migrate(workspaceId: string): Promise<void>
  resolve(workspaceId: string, conflictId: string, choice: "local" | "remote"): void
}

/** Builds the host the engine reads through. Rebuilt each render and handed over from an effect. */
function makeHost(input: SyncEngineInput): SyncEngineHost {
  return {
    getUserId: () => input.userId,
    getWorkspace: (workspaceId) => input.store?.workspaces.find((w) => w.id === workspaceId) ?? null,
    getCollections: (workspaceId) => input.getCollections(workspaceId),
    getDependencies: () => input.getDependencies(),
    getWorkspaceIds: () => (input.store?.workspaces ?? []).map((w) => w.id),
    commitRemote: (workspace) => input.onRemoteWorkspace(workspace),
    log:
      process.env.NODE_ENV === "development"
        ? (event, detail) => {
            // Identity and counts only — never payloads, cookies or tokens.
            console.debug(`[${event}]`, detail ?? {})
          }
        : undefined,
  }
}

export function useSyncEngine(input: SyncEngineInput): SyncEngineBinding {
  // One engine for the lifetime of this mount. The initializer runs on the
  // first render only, so StrictMode's double-invoked effects cannot produce
  // two schedulers, two timers or two sets of listeners.
  const [engine] = useState(() => new SyncEngine(makeHost(input)))

  // Keeps the engine's view of the world current without recreating it.
  // Handing over a new host is a method call rather than a mutation of
  // something React returned, and it runs after render rather than during it.
  useEffect(() => {
    engine.setHost(makeHost(input))
  })

  // Torn down on unmount, so a StrictMode mount/unmount/remount leaves
  // exactly one set of listeners and one timer.
  useEffect(() => {
    const teardown = installSyncTriggers(() => {
      engine.syncAll()
    })
    return () => {
      teardown()
      engine.dispose()
    }
  }, [engine])

  return useMemo<SyncEngineBinding>(
    () => ({
      notifyLocalCommit(previous, next) {
        // The diff decides what "dirty" means, so a render, a hydration or
        // an identical re-commit produces nothing here.
        for (const [workspaceId, refs] of diffStores(previous, next)) {
          engine.markDirty(workspaceId, refs)
        }
      },
      getState: (workspaceId) => engine.getState(workspaceId),
      subscribe: (listener) => engine.subscribe(listener),
      syncNow: (workspaceId) => {
        void engine.syncWorkspace(workspaceId)
      },
      migrate: async (workspaceId) => {
        await engine.migrateWorkspace(workspaceId)
      },
      resolve: (workspaceId, conflictId, choice) => {
        engine.resolveConflict(workspaceId, conflictId, choice)
      },
    }),
    [engine]
  )
}

/**
 * One workspace's sync state, re-rendering when it changes.
 *
 * `useSyncExternalStore` rather than an effect-plus-setState: the engine is
 * an external store and this is the API React provides for exactly that — no
 * subscription inside a state updater, and no tearing.
 */
export function useWorkspaceSyncState(
  binding: SyncEngineBinding,
  workspaceId: string | null
): WorkspaceJournal {
  const subscribe = useCallback((listener: () => void) => binding.subscribe(listener), [binding])
  // Memoized because useSyncExternalStore compares snapshots by identity: a
  // freshly built default on every call would re-render forever.
  const placeholder = useMemo(() => defaultJournal(workspaceId ?? ""), [workspaceId])
  const getSnapshot = useCallback(
    () => (workspaceId ? binding.getState(workspaceId) : placeholder),
    [binding, workspaceId, placeholder]
  )
  const getServerSnapshot = useCallback(() => placeholder, [placeholder])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
