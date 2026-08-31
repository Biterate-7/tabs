"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { AppearanceSettingsView } from "@/components/settings/appearance-settings-view"
import { GraphView } from "@/components/graph/graph-view"
import { isStorageAvailable, saveWorkspaceStore } from "@/lib/workspace/persistence"
import { migrateToWorkspaceStore } from "@/lib/workspace/migration"
import {
  addWorkspaces,
  createWorkspace,
  deleteWorkspace,
  getCurrentWorkspace,
  renameWorkspace,
  switchWorkspace,
  updateWorkspaceTabs,
} from "@/lib/workspace/store"
import { parseWorkspaceExport } from "@/lib/workspace/json-import"
import { mergeDependencies } from "@/lib/dependencies/relations"
import { loadDependencyState, pruneDependencyState, saveDependencyState } from "@/lib/dependencies/persistence"
import { loadCollectionState, pruneCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import { countRelationshipsByWorkspace } from "@/lib/workspace/relationships"
import { useTitleResolution } from "@/hooks/use-title-resolution"
import { useExtensionImport } from "@/hooks/use-extension-import"
import { useExtensionWorkspaceQuery } from "@/hooks/use-extension-workspace-query"
import { markDuplicates } from "@/lib/tabs"
import { buildTabsFromBrowserImport, type BrowserImportEntry } from "@/lib/tabs/browser-import"
import type { Tab } from "@/lib/tabs/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

const SIDEBAR_COLLAPSED_KEY = "tabdump:sidebar-collapsed:v1"
const RECENTLY_ADDED_DURATION_MS = 6000

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0")
  } catch {
    // Non-critical UI preference — nothing to recover if storage is unavailable.
  }
}

const IMPORT_FAILURE_MESSAGES: Record<string, string> = {
  "invalid-json": "That file isn't valid JSON.",
  "invalid-schema": "That file doesn't look like a TabDump export.",
  "unsupported-version": "That export was made with a newer version of TabDump.",
}

export function AppShell() {
  const [store, setStore] = useState<WorkspaceStore | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [canPersist, setCanPersist] = useState(true)
  const [view, setView] = useState<"workspace" | "graph" | "settings">("workspace")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Below the `md` breakpoint the sidebar is an off-canvas drawer, closed by
  // default — distinct from `sidebarCollapsed` (the desktop icon-rail
  // toggle), which has no meaningful effect on mobile.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  // Ids from the most recently completed import batch, for the "recently
  // added" tab-card treatment — ephemeral UI-only state (never persisted,
  // no Tab field backs it), cleared automatically after a short window so
  // it can never survive a reload or linger indefinitely.
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<Set<string>>(new Set())
  const recentlyAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Snapshot of the store immediately before the most recent import-type
  // mutation (initial paste dump, extension import). A ref rather than
  // state: it's only ever read inside the toast's "Undo" click handler, so
  // it doesn't need to drive a render on its own. Identity (not just value)
  // equality against this ref is how "only the latest import is undoable"
  // is enforced — see notifyImported.
  const undoSnapshotRef = useRef<WorkspaceStore | null>(null)

  useEffect(() => {
    // Hydrating from localStorage: this can only run post-mount (SSR has no
    // access to it, and reading it during render would cause a hydration
    // mismatch), so there is no way to derive this during render instead —
    // it's exactly the "synchronize with an external system on mount" case
    // effects exist for, not the derived-state anti-pattern this rule targets.
    const available = isStorageAvailable()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanPersist(available)
    setStore(migrateToWorkspaceStore())
    setSidebarCollapsed(loadSidebarCollapsed())
    if (!available) {
      toast.info("Your workspace won't be saved between visits", {
        description: "Local storage isn't available in this browser.",
      })
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    return () => {
      if (recentlyAddedTimerRef.current) clearTimeout(recentlyAddedTimerRef.current)
    }
  }, [])

  function persist(next: WorkspaceStore) {
    setStore(next)
    if (canPersist) saveWorkspaceStore(next)
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = !prev
      saveSidebarCollapsed(next)
      return next
    })
  }

  function markRecentlyAdded(ids: string[]) {
    if (ids.length === 0) return
    setRecentlyAddedIds(new Set(ids))
    if (recentlyAddedTimerRef.current) clearTimeout(recentlyAddedTimerRef.current)
    recentlyAddedTimerRef.current = setTimeout(() => {
      setRecentlyAddedIds(new Set())
    }, RECENTLY_ADDED_DURATION_MS)
  }

  function notifyImported(count: number) {
    const snapshot = undoSnapshotRef.current
    toast(`${count} tab${count === 1 ? "" : "s"} imported`, {
      action: {
        label: "Undo",
        onClick: () => {
          // Only acts if no later import has superseded this one — an
          // older toast's Undo becoming a no-op once a newer import has
          // landed is what keeps "only the latest import" true even when
          // more than one toast is still on screen.
          if (!snapshot || undoSnapshotRef.current !== snapshot) return
          persist(snapshot)
          undoSnapshotRef.current = null
        },
      },
    })
  }

  function handleDump(tabs: Tab[]) {
    if (!store) return
    const current = getCurrentWorkspace(store)
    undoSnapshotRef.current = store
    persist(updateWorkspaceTabs(store, current.id, tabs))
    markRecentlyAdded(tabs.map((t) => t.id))
    notifyImported(tabs.length)
  }

  function handleTabsChange(tabs: Tab[]) {
    if (!store) return
    persist(updateWorkspaceTabs(store, getCurrentWorkspace(store).id, tabs))
  }

  // Title resolution runs asynchronously and may still be in flight if the
  // user switches workspaces before it resolves. Binding to the workspace
  // id captured when resolution *started*, and applying it through a
  // functional update (today's latest store, not whatever `store` this
  // closure was created with), means a resolved title always lands back in
  // the workspace it was actually resolved for — never wherever the user
  // happens to be looking by the time the fetch completes.
  function handleTitlesResolved(workspaceId: string, tabs: Tab[]) {
    setStore((prev) => {
      if (!prev) return prev
      const next = updateWorkspaceTabs(prev, workspaceId, tabs)
      if (canPersist) saveWorkspaceStore(next)
      return next
    })
  }

  const currentWorkspace = store ? getCurrentWorkspace(store) : null

  // Read-only snapshot for the sidebar's per-space metadata line — recomputed
  // whenever `store` changes identity (dump, switch, clear, import, category
  // edits all go through `persist`). Deliberately NOT wired to
  // useDependencyStore: that hook is written to have exactly one live
  // instance at a time (WorkspaceView or GraphView, never both — see its own
  // doc comment), and a second reactive instance here would risk two
  // independent debounced writers racing on the same localStorage key. A
  // plain read of the persisted state avoids that risk entirely, at the cost
  // of the sidebar's relationship counts not updating instantly the moment a
  // dependency is added/removed from within the workspace — they catch up on
  // the next store-changing action.
  const relationshipCounts = useMemo(() => {
    if (!store || typeof window === "undefined") return {}
    return countRelationshipsByWorkspace(store.workspaces, loadDependencyState().dependencies)
  }, [store])

  useTitleResolution(currentWorkspace?.tabs ?? [], (tabs) => {
    if (currentWorkspace) handleTitlesResolved(currentWorkspace.id, tabs)
  })

  // Tabs arriving from the browser extension go through the exact same
  // parsing/categorization the paste flow uses (buildTabsFromBrowserImport
  // wraps parseSingleUrl + categorizeTabs), then get merged into the
  // current workspace — `markDuplicates` runs over the combined list, so
  // cross-batch duplicates are still caught, not just duplicates within the
  // incoming batch. Merging into an empty workspace's tabs is just a fresh
  // dump, so no separate "first import" branch is needed.
  function handleBrowserImport(entries: BrowserImportEntry[]) {
    if (!store) return
    const incoming = buildTabsFromBrowserImport(entries)
    if (incoming.length === 0) return

    const current = getCurrentWorkspace(store)
    undoSnapshotRef.current = store
    const merged = markDuplicates([...current.tabs, ...incoming])
    persist(updateWorkspaceTabs(store, current.id, merged))
    markRecentlyAdded(incoming.map((t) => t.id))
    notifyImported(incoming.length)
  }

  useExtensionImport(handleBrowserImport)
  useExtensionWorkspaceQuery(currentWorkspace?.tabs ?? [])

  function handleClear() {
    if (!store) return
    undoSnapshotRef.current = null
    persist(updateWorkspaceTabs(store, getCurrentWorkspace(store).id, []))
  }

  function handleSwitchWorkspace(id: string) {
    if (!store) return
    undoSnapshotRef.current = null
    persist(switchWorkspace(store, id))
  }

  function handleCreateWorkspace(name: string) {
    if (!store) return
    undoSnapshotRef.current = null
    persist(createWorkspace(store, name))
  }

  function handleRenameWorkspace(id: string, name: string) {
    if (!store) return
    persist(renameWorkspace(store, id, name))
  }

  function handleDeleteWorkspace(id: string) {
    if (!store) return
    undoSnapshotRef.current = null
    persist(deleteWorkspace(store, id))
  }

  function handleImportJson(text: string) {
    const result = parseWorkspaceExport(text)
    if (!result.ok) {
      toast.error("Couldn't import workspace", {
        description: IMPORT_FAILURE_MESSAGES[result.reason],
      })
      return
    }
    if (result.workspaces.length === 0) {
      toast.error("Couldn't import workspace", { description: "No workspaces found in that file." })
      return
    }
    if (!store) return

    const withImported = addWorkspaces(store, result.workspaces)
    persist(switchWorkspace(withImported, result.workspaces[0].id))

    // Dependencies live in their own localStorage-backed store (see
    // hooks/use-dependency-store.ts), not inside WorkspaceStore itself, so
    // they're merged directly into that persisted state here rather than
    // through `store`. Switching `currentId` above changes the key on
    // <WorkspaceView key={currentWorkspace.id}>, which remounts it and
    // makes it re-read this merge from localStorage on mount.
    if (result.dependencies.length > 0) {
      const validIds = new Set(withImported.workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
      const merged = mergeDependencies(loadDependencyState().dependencies, result.dependencies);
      saveDependencyState(pruneDependencyState({ version: 1, dependencies: merged }, validIds));
    }

    // Collections live in their own localStorage-backed store (see
    // hooks/use-collection-store.ts) — same "merge directly into persisted
    // state, not through `store`" reasoning as dependencies above. Imported
    // collections always carry freshly-minted ids (see
    // json-import.ts's sanitizeCollections), so a plain concat can't collide
    // with anything already in the store.
    if (result.collections.length > 0) {
      const validWorkspaceIds = new Set(withImported.workspaces.map((w) => w.id));
      const tabWorkspaceOf = new Map<string, string>();
      for (const w of withImported.workspaces) for (const t of w.tabs) tabWorkspaceOf.set(t.id, w.id);
      const merged = [...loadCollectionState().collections, ...result.collections];
      saveCollectionState(pruneCollectionState({ version: 1, collections: merged }, validWorkspaceIds, tabWorkspaceOf));
    }

    const skippedNote =
      result.skippedWorkspaces > 0 || result.skippedTabs > 0 || result.skippedDependencies > 0 || result.skippedCollections > 0
        ? ` (skipped ${result.skippedWorkspaces} workspace${result.skippedWorkspaces === 1 ? "" : "s"}, ${result.skippedTabs} tab${result.skippedTabs === 1 ? "" : "s"}${result.skippedDependencies > 0 ? `, ${result.skippedDependencies} dependenc${result.skippedDependencies === 1 ? "y" : "ies"}` : ""}${result.skippedCollections > 0 ? `, ${result.skippedCollections} collection${result.skippedCollections === 1 ? "" : "s"}` : ""})`
        : ""
    toast.success(
      `Imported ${result.workspaces.length} workspace${result.workspaces.length === 1 ? "" : "s"}${skippedNote}`
    )
  }

  if (!hydrated || !store || !currentWorkspace) return null

  if (view === "graph") {
    return <GraphView store={store} onStoreUpdate={persist} onClose={() => setView("workspace")} />
  }

  if (view === "settings") {
    return <AppearanceSettingsView onClose={() => setView("workspace")} />
  }

  return (
    <div className="flex min-h-screen">
      <AppSidebar
        workspaces={store.workspaces}
        currentId={store.currentId}
        relationshipCounts={relationshipCounts}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        onMobileOpenChange={setMobileSidebarOpen}
        onSwitch={handleSwitchWorkspace}
        onCreate={handleCreateWorkspace}
        onRename={handleRenameWorkspace}
        onDelete={handleDeleteWorkspace}
        onImportFile={handleImportJson}
        onOpenGraph={() => setView("graph")}
        onOpenSettings={() => setView("settings")}
      />
      <div
        className="min-w-0 flex-1"
        // Settings → Appearance → Layout → Content width (see resolve.ts).
        // "Full" resolves to `none`, i.e. today's unconstrained behavior.
        style={{ maxWidth: "var(--tabdump-content-max-width)", marginInline: "auto" }}
      >
        {currentWorkspace.tabs.length === 0 ? (
          <LandingView onDump={handleDump} onOpenSidebar={() => setMobileSidebarOpen(true)} />
        ) : (
          // Keyed on the workspace id so switching workspaces remounts
          // fresh — search/filter/sort/selection state from the previous
          // workspace has no business surviving into a different one.
          <WorkspaceView
            key={currentWorkspace.id}
            tabs={currentWorkspace.tabs}
            onTabsChange={handleTabsChange}
            onClear={handleClear}
            currentWorkspace={currentWorkspace}
            allWorkspaces={store.workspaces}
            onStoreUpdate={persist}
            onOpenGraph={() => setView("graph")}
            onSwitchWorkspace={handleSwitchWorkspace}
            recentlyAddedIds={recentlyAddedIds}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
          />
        )}
      </div>
    </div>
  )
}
