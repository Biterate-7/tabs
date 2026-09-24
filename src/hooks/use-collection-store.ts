"use client"

import { useEffect, useMemo, useState } from "react"
import {
  addTabToCollection,
  addTabsToCollection,
  createCollection,
  deleteCollection,
  moveTabToCollection,
  removeTabFromCollection,
  removeTabsFromCollection,
  renameCollection,
} from "@/lib/collections/relations"
import {
  defaultCollectionState,
  loadCollectionState,
  pruneCollectionState,
  saveCollectionState,
} from "@/lib/collections/persistence"
import { applyCollectionBatch } from "@/lib/collections/batch"
import { createTimestamp } from "@/lib/timestamps"
import { publishSyncDirty, subscribeRemoteEntities } from "@/lib/sync/notify"
import type { CollectionBatchOperation, CollectionBatchResult } from "@/lib/collections/batch"
import type { Collection } from "@/lib/collections/types"
import type { Workspace } from "@/lib/workspace/types"

const SAVE_DEBOUNCE_MS = 400

/**
 * Which collections currently hold any of `tabIds`.
 *
 * A tab belongs to at most one collection, so adding it somewhere new
 * silently removes it from wherever it was (stripFromAllCollections). That
 * second collection changed too, and reporting only the named one would
 * leave the other's membership stale on every other device.
 */
function holdersOf(collections: readonly Collection[], tabIds: readonly string[]): string[] {
  if (tabIds.length === 0) return []
  const wanted = new Set(tabIds)
  return collections.filter((c) => c.tabIds.some((id) => wanted.has(id))).map((c) => c.id)
}

/**
 * Loads the collection store from localStorage once on mount and keeps it
 * saved as it changes — the same "load-once-per-mount, source of truth is
 * localStorage" pattern use-dependency-store.ts already established. Safe to
 * use from more than one call site (WorkspaceView and GraphView) because
 * TabDump only ever mounts one of them at a time — see app-shell.tsx's
 * `view` switch.
 *
 * `workspaces` is the full cross-workspace list (not just the current one):
 * collections are workspace-scoped, so pruning a stale reference (a deleted
 * workspace, a tab moved elsewhere) needs to know where every tab currently
 * lives, not just what's visible right now. The returned `collections` is a
 * *derived* view, pruned against `workspaces` on every read rather than by
 * calling setState from an effect — same "filter at read/save time" approach
 * the dependency store uses. A tab moved to a different workspace, or a
 * workspace getting deleted, is reflected here the very next render.
 */
export function useCollectionStore(workspaces: Workspace[]) {
  const [rawCollections, setCollections] = useState<Collection[]>(() => {
    if (typeof window === "undefined") return defaultCollectionState().collections
    return loadCollectionState().collections
  })

  const validWorkspaceIds = useMemo(() => new Set(workspaces.map((w) => w.id)), [workspaces])
  const tabWorkspaceOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const workspace of workspaces) {
      for (const tab of workspace.tabs) map.set(tab.id, workspace.id)
    }
    return map
  }, [workspaces])

  const collections = useMemo(
    () =>
      pruneCollectionState({ version: 1, collections: rawCollections }, validWorkspaceIds, tabWorkspaceOf)
        .collections,
    [rawCollections, validWorkspaceIds, tabWorkspaceOf]
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      saveCollectionState({ version: 1, collections })
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [collections])

  // Collections the engine pulled from the server. Applied through this hook
  // rather than written to localStorage by the engine, because this hook is
  // the single writer of that key — the effect above would otherwise clobber
  // the engine's write with stale React state.
  //
  // Deliberately does NOT publish a dirty event: the value came from the
  // server, and re-marking it would push it straight back.
  useEffect(
    () =>
      subscribeRemoteEntities((event) => {
        if (!event.collections) return
        const { workspaceId, items } = event.collections
        // Replaces only the named workspace's slice. The event carries one
        // workspace's collections, not the whole store, so assigning it
        // wholesale would drop every other workspace's.
        setCollections((current) => [
          ...current.filter((c) => c.workspaceId !== workspaceId),
          ...(items as Collection[]),
        ])
      }),
    []
  )

  return useMemo(() => {
    /**
     * Announces changed collections to the sync engine.
     *
     * Called from action handlers, never from inside a `setCollections`
     * updater — React may evaluate an updater more than once, and publishing
     * there would report a mutation twice.
     *
     * The workspace is resolved from current state because the event has to
     * name one: the engine schedules per workspace. A deletion passes the id
     * explicitly since the row is about to be gone from local state.
     */
    const publishCollections = (ids: readonly string[], workspaceId?: string, deleted = false) => {
      const byId = new Map(collections.map((c) => [c.id, c]))
      const seen = new Set<string>()
      const events = []
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        const resolved = workspaceId ?? byId.get(id)?.workspaceId
        // An id whose workspace cannot be resolved is dropped rather than
        // guessed: the engine keys work by workspace, and a wrong one would
        // schedule a push against the wrong workspace.
        if (!resolved) continue
        events.push({ entityType: "collection" as const, entityId: id, workspaceId: resolved, deleted })
      }
      publishSyncDirty(events)
    }

    return {
      collections,
      setCollections,
      // Computed from `collections` directly (not via a setState updater
      // function) because the caller needs the newly created Collection's id
      // back synchronously — e.g. to focus it right after Gather completes.
      // React doesn't guarantee an updater function runs before setState
      // returns, so a functional update can't hand back a result this way;
      // reading this render's already-current `collections` and calling
      // setCollections with the computed array is what makes that safe.
      createCollection: (workspaceId: string, name: string, tabIds: string[] = []) => {
        const result = createCollection(collections, workspaceId, name, tabIds, createTimestamp())
        setCollections(result.collections)
        // Seeding a new collection pulls each tab out of whatever collection
        // held it (the "a tab belongs to at most one collection" rule), so
        // those are dirty too.
        publishCollections([result.collection.id, ...holdersOf(collections, tabIds)], workspaceId)
        return result.collection
      },
      // Each of these reads the clock once, here, where the user's mutation
      // actually happens, and passes it into the reducer. Letting the reducer
      // default it would put the read inside the updater, which React may
      // evaluate more than once (twice per update under StrictMode) — minting
      // a timestamp that is then thrown away. The updater stays a pure
      // reducer call, so "apply to the latest state" still holds.
      renameCollection: (id: string, name: string) => {
        const now = createTimestamp()
        setCollections((prev) => renameCollection(prev, id, name, now))
        publishCollections([id])
      },
      deleteCollection: (id: string) => {
        setCollections((prev) => deleteCollection(prev, id))
        // Published as a deletion so the server receives a tombstone. A
        // collection that merely vanished from the dirty set would live on
        // forever on every other device.
        publishCollections([id], undefined, true)
      },
      addTabToCollection: (collectionId: string, tabId: string) => {
        const now = createTimestamp()
        setCollections((prev) => addTabToCollection(prev, collectionId, tabId, now))
        publishCollections([collectionId, ...holdersOf(collections, [tabId])])
      },
      addTabsToCollection: (collectionId: string, tabIds: string[]) => {
        const now = createTimestamp()
        setCollections((prev) => addTabsToCollection(prev, collectionId, tabIds, now))
        publishCollections([collectionId, ...holdersOf(collections, tabIds)])
      },
      removeTabFromCollection: (collectionId: string, tabId: string) => {
        const now = createTimestamp()
        setCollections((prev) => removeTabFromCollection(prev, collectionId, tabId, now))
        publishCollections([collectionId])
      },
      removeTabsFromCollection: (collectionId: string, tabIds: string[]) => {
        const now = createTimestamp()
        setCollections((prev) => removeTabsFromCollection(prev, collectionId, tabIds, now))
        publishCollections([collectionId])
      },
      moveTabToCollection: (tabId: string, targetCollectionId: string) => {
        const now = createTimestamp()
        setCollections((prev) => moveTabToCollection(prev, tabId, targetCollectionId, now))
        publishCollections([targetCollectionId, ...holdersOf(collections, [tabId])])
      },
      /**
       * Several changes to one workspace's collections as one (Phase J.5):
       * all of them, or none. The batch is folded through the same reducers
       * the single operations above use (lib/collections/batch.ts) against
       * this render's collections, and only a batch that holds throughout is
       * committed — in one write, announced once. Returned so the caller
       * knows the ids it created, or which operation did not fit.
       */
      applyBatch: (workspaceId: string, operations: readonly CollectionBatchOperation[]): CollectionBatchResult => {
        const tabIds = new Set<string>()
        for (const [tabId, owner] of tabWorkspaceOf) if (owner === workspaceId) tabIds.add(tabId)
        const result = applyCollectionBatch(collections, { workspaceId, tabIds }, operations, createTimestamp())
        if (!result.ok) return result
        setCollections(result.collections)
        publishCollections(result.touched, workspaceId)
        return result
      },
    }
  }, [collections, tabWorkspaceOf])
}
