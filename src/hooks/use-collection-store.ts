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
import { createTimestamp } from "@/lib/timestamps"
import type { Collection } from "@/lib/collections/types"
import type { Workspace } from "@/lib/workspace/types"

const SAVE_DEBOUNCE_MS = 400

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

  return useMemo(
    () => ({
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
      },
      deleteCollection: (id: string) => setCollections((prev) => deleteCollection(prev, id)),
      addTabToCollection: (collectionId: string, tabId: string) => {
        const now = createTimestamp()
        setCollections((prev) => addTabToCollection(prev, collectionId, tabId, now))
      },
      addTabsToCollection: (collectionId: string, tabIds: string[]) => {
        const now = createTimestamp()
        setCollections((prev) => addTabsToCollection(prev, collectionId, tabIds, now))
      },
      removeTabFromCollection: (collectionId: string, tabId: string) => {
        const now = createTimestamp()
        setCollections((prev) => removeTabFromCollection(prev, collectionId, tabId, now))
      },
      removeTabsFromCollection: (collectionId: string, tabIds: string[]) => {
        const now = createTimestamp()
        setCollections((prev) => removeTabsFromCollection(prev, collectionId, tabIds, now))
      },
      moveTabToCollection: (tabId: string, targetCollectionId: string) => {
        const now = createTimestamp()
        setCollections((prev) => moveTabToCollection(prev, tabId, targetCollectionId, now))
      },
    }),
    [collections]
  )
}
