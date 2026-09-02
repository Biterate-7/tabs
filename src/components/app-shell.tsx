"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { AppearanceSettingsView } from "@/components/settings/appearance-settings-view"
import { GraphView } from "@/components/graph/graph-view"
import { FavoritesView } from "@/components/workspace/favorites-view"
import { RecentsView } from "@/components/workspace/recents-view"
import { HistoryDumpView } from "@/components/workspace/history-dump-view"
import { isStorageAvailable, saveWorkspaceStore } from "@/lib/workspace/persistence"
import { migrateToWorkspaceStore } from "@/lib/workspace/migration"
import {
  addWorkspaces,
  assignTabsToSection,
  createSectionInWorkspace,
  createWorkspace,
  deleteSectionInWorkspace,
  deleteWorkspace,
  getCurrentWorkspace,
  renameSectionInWorkspace,
  renameWorkspace,
  switchWorkspace,
  updateWorkspaceLogo,
  updateWorkspaceTabs,
} from "@/lib/workspace/store"
import { parseWorkspaceExport } from "@/lib/workspace/json-import"
import { ensureSectionsSeededInStore, syncSectionsWithCategoriesInStore } from "@/lib/sections/migrate"
import { organizeTabsIntoSections } from "@/lib/sections/ai/organize"
import { computeSemanticClusterHints } from "@/lib/ai/cluster"
import type { Section } from "@/lib/sections/types"
import { mergeDependencies } from "@/lib/dependencies/relations"
import { loadDependencyState, pruneDependencyState, saveDependencyState } from "@/lib/dependencies/persistence"
import { loadCollectionState, pruneCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import { countRelationshipsByWorkspace } from "@/lib/workspace/relationships"
import { useTitleResolution } from "@/hooks/use-title-resolution"
import { useExtensionImport } from "@/hooks/use-extension-import"
import { useExtensionWorkspaceQuery } from "@/hooks/use-extension-workspace-query"
import { useAutoOrganize } from "@/hooks/use-auto-organize"
import { markDuplicates } from "@/lib/tabs"
import { buildTabsFromBrowserImport, type BrowserImportEntry } from "@/lib/tabs/browser-import"
import { applyOrganizationPlan } from "@/lib/organize/apply"
import type { OrganizationPlan } from "@/lib/organize/types"
import type { Tab } from "@/lib/tabs/types"
import type { CategoryId } from "@/lib/categories"
import type { WorkspaceStore } from "@/lib/workspace/types"
import { openTab } from "@/lib/browser/open-tab"

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
  const [view, setView] = useState<"workspace" | "graph" | "settings" | "favorites" | "recents" | "history-dump">("workspace")
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
  // Snapshot immediately before an Auto-Organize apply — separate from
  // undoSnapshotRef (the import undo) since the two are independent
  // operations a user might want to undo separately, e.g. keep the import
  // but undo just the reorganization.
  const organizeUndoSnapshotRef = useRef<WorkspaceStore | null>(null)
  const [applyingOrganize, setApplyingOrganize] = useState(false)
  const autoOrganize = useAutoOrganize()

  useEffect(() => {
    // Hydrating from localStorage: this can only run post-mount (SSR has no
    // access to it, and reading it during render would cause a hydration
    // mismatch), so there is no way to derive this during render instead —
    // it's exactly the "synchronize with an external system on mount" case
    // effects exist for, not the derived-state anti-pattern this rule targets.
    const available = isStorageAvailable()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanPersist(available)
    const migrated = migrateToWorkspaceStore()
    // One-time, idempotent: seeds a root section per legacy category for any
    // workspace that predates sections (spec §26) — never reorganizes a tab
    // that already has one. ensureSectionsSeededInStore always returns a new
    // top-level object, so only persist when a workspace actually changed.
    const seeded = ensureSectionsSeededInStore(migrated)
    // Heals any workspace whose sections had already drifted from its tabs'
    // flat categories before this fix existed (e.g. a tab recategorized
    // without ever going through a dump/import) — see
    // syncSectionsWithCategories's doc comment for why that drift happens.
    const synced = syncSectionsWithCategoriesInStore(seeded)
    const changedOnLoad = synced.workspaces.some((w, i) => w !== migrated.workspaces[i])
    setStore(synced)
    if (available && changedOnLoad) saveWorkspaceStore(synced)
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

  // Every mutation flows through here, so this is the single chokepoint that
  // keeps root sections aligned with each tab's flat category — see
  // syncSectionsWithCategories's doc comment for why that can otherwise
  // drift (recategorizing a tab, or bulk-recategorizing a selection, never
  // goes through the async AI/fallback organizer that dumps/imports do).
  // Idempotent and referentially stable per-workspace when nothing needs
  // fixing, so this adds no meaningful overhead to the common case.
  function persist(next: WorkspaceStore) {
    const synced = syncSectionsWithCategoriesInStore(next)
    setStore(synced)
    if (canPersist) saveWorkspaceStore(synced)
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
    const next = updateWorkspaceTabs(store, current.id, tabs)
    persist(next)
    markRecentlyAdded(tabs.map((t) => t.id))
    notifyImported(tabs.length)
    autoOrganize.analyze(getCurrentWorkspace(next), next.workspaces)
    const nextWorkspace = getCurrentWorkspace(next)
    organizeNewTabsIntoSections(nextWorkspace.id, tabs, nextWorkspace.sections ?? [])
  }

  function handleTabsChange(tabs: Tab[]) {
    if (!store) return
    persist(updateWorkspaceTabs(store, getCurrentWorkspace(store).id, tabs))
  }

  // Favorites/Recents render as siblings of WorkspaceView rather than inside
  // it, so they need their own copies of the same small per-tab mutations
  // WorkspaceView already has (handleCategoryChange/handleToggleFavorite/
  // handleOpenTab/handleNotesChange there) — all of them funnel through the
  // same handleTabsChange → persist path, just scoped from currentWorkspace
  // instead of WorkspaceView's local `tabs` prop.
  function handleCategoryChangeInView(id: string, category: CategoryId) {
    if (!currentWorkspace) return
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, category } : t)))
  }

  function handleToggleFavoriteInView(id: string) {
    if (!currentWorkspace) return
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, isFavorite: !t.isFavorite } : t)))
  }

  function handleOpenTabInView(id: string) {
    if (!currentWorkspace) return
    const tab = currentWorkspace.tabs.find((t) => t.id === id)
    if (!tab) return
    openTab(tab.url)
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, lastAccessedAt: Date.now() } : t)))
  }

  function handleNotesChangeInView(id: string, notes: string) {
    if (!currentWorkspace) return
    const trimmed = notes.trim()
    handleTabsChange(currentWorkspace.tabs.map((t) => (t.id === id ? { ...t, notes: trimmed || undefined } : t)))
  }

  // Title resolution runs asynchronously and may still be in flight if the
  // user switches workspaces before it resolves. Binding to the workspace
  // id captured when resolution *started*, and applying it through a
  // functional update (today's latest store, not whatever `store` this
  // closure was created with), means a resolved title always lands back in
  // the workspace it was actually resolved for — never wherever the user
  // happens to be looking by the time the fetch completes.
  //
  // `tabs` is useTitleResolution's own snapshot, built from whatever tabs
  // looked like when its effect started — patching in just the `title`
  // field by id onto the workspace's CURRENT tabs (rather than replacing
  // the array with this stale snapshot wholesale) means a concurrent edit
  // to some other field (category, sectionId from organizeNewTabsIntoSections,
  // notes, ...) that landed while resolution was in flight survives instead
  // of being silently reverted by an unrelated title update.
  function handleTitlesResolved(workspaceId: string, tabs: Tab[]) {
    setStore((prev) => {
      if (!prev) return prev
      const workspace = prev.workspaces.find((w) => w.id === workspaceId)
      if (!workspace) return prev
      const resolvedById = new Map(tabs.map((t) => [t.id, t]))
      const mergedTabs = workspace.tabs.map((t) => {
        const resolved = resolvedById.get(t.id)
        return resolved && resolved.title !== t.title ? { ...t, title: resolved.title } : t
      })
      const next = updateWorkspaceTabs(prev, workspaceId, mergedTabs)
      if (canPersist) saveWorkspaceStore(next)
      return next
    })
  }

  // Runs the AI section-organization engine (src/lib/sections/ai/organize.ts)
  // over `tabsSnapshot` and merges the result back into whichever workspace
  // matching `workspaceId` looks like BY THE TIME THE CALL RESOLVES (a
  // functional setStore update, same "always merge into the latest state"
  // pattern handleTitlesResolved uses) — never the stale `store` this
  // function's caller closed over. New sections are unioned in rather than
  // overwriting the workspace's current list, so a section the user created
  // while this was in flight survives. Tabs no longer present in the
  // workspace (deleted/moved meanwhile) are silently skipped. Deliberately
  // fire-and-forget from every call site: this NEVER blocks or fails a dump
  // (spec §28) — organizeTabsIntoSections itself never throws, and this
  // wrapper's own best-effort embedding-hint lookup is wrapped separately.
  async function organizeNewTabsIntoSections(workspaceId: string, tabsSnapshot: Tab[], sectionsSnapshot: Section[]) {
    if (tabsSnapshot.length === 0) return

    let hints: Awaited<ReturnType<typeof computeSemanticClusterHints>> = []
    try {
      hints = await computeSemanticClusterHints([workspaceId])
    } catch {
      // Best-effort signal only — organizeTabsIntoSections works fine without it.
    }

    const result = await organizeTabsIntoSections(tabsSnapshot, sectionsSnapshot, hints)

    setStore((prev) => {
      if (!prev) return prev
      const workspace = prev.workspaces.find((w) => w.id === workspaceId)
      if (!workspace) return prev

      const existingSectionIds = new Set((workspace.sections ?? []).map((s) => s.id))
      const newSections = result.sections.filter((s) => !existingSectionIds.has(s.id))
      const sections = [...(workspace.sections ?? []), ...newSections]

      const organizedById = new Map(result.tabs.map((t) => [t.id, t]))
      const tabs = workspace.tabs.map((t) => organizedById.get(t.id) ?? t)

      const workspaces = prev.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, sections, tabs, updatedAt: Date.now() } : w
      )
      const next = { ...prev, workspaces }
      if (canPersist) saveWorkspaceStore(next)
      return next
    })
  }

  function handleCreateSection(parentId: string | null, name: string) {
    if (!store || !currentWorkspace) return
    const result = createSectionInWorkspace(store, currentWorkspace.id, parentId, name, "user")
    if (!result) {
      toast.error("Couldn't create that section", {
        description: parentId ? "Sections can be nested at most 3 levels deep." : undefined,
      })
      return
    }
    persist(result.store)
  }

  function handleRenameSection(id: string, name: string) {
    if (!store || !currentWorkspace) return
    persist(renameSectionInWorkspace(store, currentWorkspace.id, id, name))
  }

  function handleDeleteSection(id: string, reassignToSectionId?: string) {
    if (!store || !currentWorkspace) return
    persist(deleteSectionInWorkspace(store, currentWorkspace.id, id, reassignToSectionId))
  }

  function handleAssignTabToSection(tabId: string, sectionId: string) {
    if (!store || !currentWorkspace) return
    persist(assignTabsToSection(store, currentWorkspace.id, [tabId], sectionId))
  }

  async function handleReorganizeSections() {
    if (!currentWorkspace) return
    const unlocked = currentWorkspace.tabs.filter((t) => !t.sectionLocked)
    if (unlocked.length === 0) {
      toast.info("Nothing to reorganize", { description: "Every tab here has been manually placed." })
      return
    }
    toast.info(`Reorganizing ${unlocked.length} tab${unlocked.length === 1 ? "" : "s"}…`)
    await organizeNewTabsIntoSections(currentWorkspace.id, unlocked, currentWorkspace.sections ?? [])
    toast.success("Reorganized")
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
  function notifyHistoryDumped(count: number, skipped: number) {
    const snapshot = undoSnapshotRef.current
    toast(`${count} tab${count === 1 ? "" : "s"} dumped`, {
      description: skipped > 0 ? `${skipped} ${skipped === 1 ? "was" : "were"} already in TabDump` : undefined,
      action: {
        label: "Undo",
        onClick: () => {
          if (!snapshot || undoSnapshotRef.current !== snapshot) return
          persist(snapshot)
          undoSnapshotRef.current = null
        },
      },
    })
  }

  // History Dump's own merge step (AGENTS.md section 36): unlike
  // handleBrowserImport, this filters out anything that already exists in
  // the current workspace *before* merging, rather than letting markDuplicates
  // flag it after the fact — History Dump's review screen already lets the
  // user see "already in TabDump" candidates, so nothing selected from there
  // should ever land as a second copy. Entries still funnel through the exact
  // same buildTabsFromBrowserImport ingestion the popup-driven dump uses.
  function handleHistoryDump(entries: BrowserImportEntry[]) {
    if (!store) return
    const incoming = buildTabsFromBrowserImport(entries)
    if (incoming.length === 0) return

    const current = getCurrentWorkspace(store)
    const existingNormalized = new Set(current.tabs.map((t) => t.normalizedUrl))
    const fresh = incoming.filter((t) => !existingNormalized.has(t.normalizedUrl))
    const skipped = incoming.length - fresh.length

    if (fresh.length === 0) {
      toast.info("Nothing new to add", { description: "All selected pages are already in TabDump." })
      setView("workspace")
      return
    }

    undoSnapshotRef.current = store
    const merged = markDuplicates([...current.tabs, ...fresh])
    const next = updateWorkspaceTabs(store, current.id, merged)
    persist(next)
    markRecentlyAdded(fresh.map((t) => t.id))
    notifyHistoryDumped(fresh.length, skipped)
    autoOrganize.analyze(getCurrentWorkspace(next), next.workspaces)
    const nextWorkspace = getCurrentWorkspace(next)
    // Re-resolve the just-dumped tabs from the post-merge workspace (not the
    // pre-merge `fresh` array) so their markDuplicates-assigned `isDuplicate`
    // flag survives — organizeNewTabsIntoSections completely replaces each
    // organized tab object with whatever it's given.
    const freshIds = new Set(fresh.map((t) => t.id))
    organizeNewTabsIntoSections(nextWorkspace.id, nextWorkspace.tabs.filter((t) => freshIds.has(t.id)), nextWorkspace.sections ?? [])
    setView("workspace")
  }

  function handleBrowserImport(entries: BrowserImportEntry[]) {
    if (!store) return
    const incoming = buildTabsFromBrowserImport(entries)
    if (incoming.length === 0) return

    const current = getCurrentWorkspace(store)
    undoSnapshotRef.current = store
    const merged = markDuplicates([...current.tabs, ...incoming])
    const next = updateWorkspaceTabs(store, current.id, merged)
    persist(next)
    markRecentlyAdded(incoming.map((t) => t.id))
    notifyImported(incoming.length)
    autoOrganize.analyze(getCurrentWorkspace(next), next.workspaces)
    const nextWorkspace = getCurrentWorkspace(next)
    const incomingIds = new Set(incoming.map((t) => t.id))
    organizeNewTabsIntoSections(nextWorkspace.id, nextWorkspace.tabs.filter((t) => incomingIds.has(t.id)), nextWorkspace.sections ?? [])
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

  function handleUpdateWorkspaceLogo(id: string, logo: string | undefined) {
    if (!store) return
    persist(updateWorkspaceLogo(store, id, logo))
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

  function handleRequestOrganize() {
    if (!store || !currentWorkspace) return
    autoOrganize.analyze(currentWorkspace, store.workspaces)
  }

  function handleApplyAutoOrganize(plan: OrganizationPlan) {
    if (!store) return
    organizeUndoSnapshotRef.current = store
    setApplyingOrganize(true)
    const result = applyOrganizationPlan(plan, store)
    setApplyingOrganize(false)
    autoOrganize.dismiss()
    if (!result.storeChanged) {
      toast.error("Couldn't organize these tabs automatically", { description: result.text })
      return
    }
    const before = organizeUndoSnapshotRef.current
    persist(result.store)
    toast(result.text, {
      action: {
        label: "Undo",
        onClick: () => {
          if (!before || organizeUndoSnapshotRef.current !== before) return
          persist(before)
          organizeUndoSnapshotRef.current = null
        },
      },
    })
  }

  if (!hydrated || !store || !currentWorkspace) return null

  if (view === "graph") {
    return <GraphView store={store} onStoreUpdate={persist} onClose={() => setView("workspace")} />
  }

  if (view === "settings") {
    return <AppearanceSettingsView onClose={() => setView("workspace")} />
  }

  if (view === "favorites") {
    return (
      <FavoritesView
        tabs={currentWorkspace.tabs}
        onClose={() => setView("workspace")}
        onCategoryChange={handleCategoryChangeInView}
        onToggleFavorite={handleToggleFavoriteInView}
        onOpenTab={handleOpenTabInView}
        onNotesChange={handleNotesChangeInView}
      />
    )
  }

  if (view === "recents") {
    return (
      <RecentsView
        tabs={currentWorkspace.tabs}
        onClose={() => setView("workspace")}
        onCategoryChange={handleCategoryChangeInView}
        onToggleFavorite={handleToggleFavoriteInView}
        onOpenTab={handleOpenTabInView}
        onNotesChange={handleNotesChangeInView}
      />
    )
  }

  if (view === "history-dump") {
    return (
      <HistoryDumpView
        tabs={currentWorkspace.tabs}
        onClose={() => setView("workspace")}
        onDump={handleHistoryDump}
      />
    )
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
        onUpdateLogo={handleUpdateWorkspaceLogo}
        onOpenFavorites={() => setView("favorites")}
        onOpenRecents={() => setView("recents")}
        onOpenHistoryDump={() => setView("history-dump")}
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
            onOpenGraph={() => setView("graph")}
            onOpenFavorites={() => setView("favorites")}
            onOpenRecents={() => setView("recents")}
            onOpenHistoryDump={() => setView("history-dump")}
            onSwitchWorkspace={handleSwitchWorkspace}
            recentlyAddedIds={recentlyAddedIds}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
            autoOrganizePlan={autoOrganize.plan}
            autoOrganizeApplying={applyingOrganize}
            onApplyAutoOrganize={handleApplyAutoOrganize}
            onDismissAutoOrganize={autoOrganize.dismiss}
            onRequestOrganize={handleRequestOrganize}
            onCreateSection={handleCreateSection}
            onRenameSection={handleRenameSection}
            onDeleteSection={handleDeleteSection}
            onAssignTabToSection={handleAssignTabToSection}
            onReorganizeSections={handleReorganizeSections}
          />
        )}
      </div>
    </div>
  )
}
