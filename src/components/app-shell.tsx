"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher"
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
import { useTitleResolution } from "@/hooks/use-title-resolution"
import { useExtensionImport } from "@/hooks/use-extension-import"
import { useExtensionWorkspaceQuery } from "@/hooks/use-extension-workspace-query"
import { markDuplicates } from "@/lib/tabs"
import { buildTabsFromBrowserImport, type BrowserImportEntry } from "@/lib/tabs/browser-import"
import type { Tab } from "@/lib/tabs/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

const IMPORT_FAILURE_MESSAGES: Record<string, string> = {
  "invalid-json": "That file isn't valid JSON.",
  "invalid-schema": "That file doesn't look like a TabDump export.",
  "unsupported-version": "That export was made with a newer version of TabDump.",
}

export function AppShell() {
  const [store, setStore] = useState<WorkspaceStore | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [canPersist, setCanPersist] = useState(true)
  const [view, setView] = useState<"workspace" | "graph">("workspace")
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
    if (!available) {
      toast.info("Your workspace won't be saved between visits", {
        description: "Local storage isn't available in this browser.",
      })
    }
    setHydrated(true)
  }, [])

  function persist(next: WorkspaceStore) {
    setStore(next)
    if (canPersist) saveWorkspaceStore(next)
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

    const skippedNote =
      result.skippedWorkspaces > 0 || result.skippedTabs > 0
        ? ` (skipped ${result.skippedWorkspaces} workspace${result.skippedWorkspaces === 1 ? "" : "s"}, ${result.skippedTabs} tab${result.skippedTabs === 1 ? "" : "s"})`
        : ""
    toast.success(
      `Imported ${result.workspaces.length} workspace${result.workspaces.length === 1 ? "" : "s"}${skippedNote}`
    )
  }

  if (!hydrated || !store || !currentWorkspace) return null

  if (view === "graph") {
    return <GraphView store={store} onStoreUpdate={persist} onClose={() => setView("workspace")} />
  }

  const switcher = (
    <WorkspaceSwitcher
      workspaces={store.workspaces}
      currentId={store.currentId}
      onSwitch={handleSwitchWorkspace}
      onCreate={handleCreateWorkspace}
      onRename={handleRenameWorkspace}
      onDelete={handleDeleteWorkspace}
      onImportFile={handleImportJson}
    />
  )

  if (currentWorkspace.tabs.length === 0) {
    return <LandingView onDump={handleDump} workspaceSwitcher={switcher} />
  }

  return (
    // Keyed on the workspace id so switching workspaces remounts fresh —
    // search/filter/sort/selection state from the previous workspace has
    // no business surviving into a different one.
    <WorkspaceView
      key={currentWorkspace.id}
      tabs={currentWorkspace.tabs}
      onTabsChange={handleTabsChange}
      onClear={handleClear}
      workspaceSwitcher={switcher}
      currentWorkspace={currentWorkspace}
      allWorkspaces={store.workspaces}
      onStoreUpdate={persist}
      onOpenGraph={() => setView("graph")}
    />
  )
}
