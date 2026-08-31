"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Search as SearchIcon,
  LayoutGrid,
  AlertCircle as DuplicatesIcon,
  Sparkles,
  Download,
  Trash2,
  ArrowUpDown,
  Keyboard,
  CheckSquare,
  X,
  Waypoints,
  Layers,
  Pencil,
  ExternalLink as OpenAllIcon,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { CleanupDialog } from "@/components/workspace/cleanup-dialog"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"
import { ShortcutsDialog } from "@/components/workspace/shortcuts-dialog"
import { SelectionToolbar } from "@/components/workspace/selection-toolbar"
import { removeTabs } from "@/lib/workspace/cleanup"
import { AttentionStrip } from "@/components/workspace/attention-strip"
import { computeAttention } from "@/lib/workspace/attention"
import { WorkspaceOverview } from "@/components/workspace/workspace-overview"
import { CategoryGrid } from "@/components/workspace/category-grid"
import { CategoryFilterBar } from "@/components/workspace/category-filter-bar"
import { SortControl } from "@/components/workspace/sort-control"
import { FilteredTabList } from "@/components/workspace/filtered-tab-list"
import { CommandPalette } from "@/components/command-palette/command-palette"
import type { Command } from "@/components/command-palette/types"
import { AskTabDumpPanel } from "@/components/ai/ask-tabdump-panel"
import { filterTabs, sortTabs, categoryCounts } from "@/lib/workspace/search"
import type { SortKey } from "@/lib/workspace/search"
import { copyText, urlsText } from "@/lib/workspace/export"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { useWorkspaceShortcuts } from "@/hooks/use-workspace-shortcuts"
import { useAiIndexing } from "@/hooks/use-ai-indexing"
import { useDependencyStore } from "@/hooks/use-dependency-store"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"
import { openTab } from "@/lib/browser/open-tab"
import { GraphLinkDialog } from "@/components/graph/graph-link-dialog"
import { TabInspector } from "@/components/workspace/tab-inspector"
import { buildGraphNodes, buildWorkspaceLookup } from "@/lib/graph/relations"
import { dependenciesOf, groupDependenciesByChild, groupDependenciesByParent, usedBy } from "@/lib/dependencies/relations"
import { validateDependency } from "@/lib/dependencies/validation"
import { buildDependencyTree } from "@/lib/dependencies/tree"
import type { DependencyType } from "@/lib/dependencies/types"
import type { DependencyIndicatorData } from "@/components/workspace/tab-dependency-indicator"
import { useCollectionStore } from "@/hooks/use-collection-store"
import { getCollectionsForWorkspace, getCollectionTabs } from "@/lib/collections/relations"
import { validateAddTabToCollection } from "@/lib/collections/validation"
import { CollectionsSection } from "@/components/workspace/collections-section"
import { GatherDialog } from "@/components/workspace/gather-dialog"
import { RenameCollectionDialog } from "@/components/workspace/rename-collection-dialog"
import { DeleteCollectionDialog } from "@/components/workspace/delete-collection-dialog"

const SORT_LABELS: Record<SortKey, string> = {
  recent: "recently added",
  title: "title",
  domain: "domain",
  category: "category",
}

export function WorkspaceView({
  tabs,
  onTabsChange,
  onClear,
  currentWorkspace,
  allWorkspaces,
  onStoreUpdate,
  onOpenGraph,
  onSwitchWorkspace,
  recentlyAddedIds,
  onOpenSidebar,
}: {
  tabs: Tab[]
  onTabsChange: (tabs: Tab[]) => void
  onClear: () => void
  currentWorkspace?: Workspace
  allWorkspaces?: Workspace[]
  /** Lets Ask TabDump's agent mode write back a store mutated by an action (create/rename workspace, move tabs, etc). */
  onStoreUpdate?: (store: WorkspaceStore) => void
  onOpenGraph?: () => void
  /** Backs the command palette's "Switch to <space>" entries — omitted in standalone/test contexts that don't wire up a store. */
  onSwitchWorkspace?: (id: string) => void
  /** Ids from the most recently completed dump/import — drives TabCard's "recently added" highlight. Omitted (not just empty) outside AppShell. */
  recentlyAddedIds?: Set<string>
  /** Opens the mobile sidebar drawer — omitted in standalone/test contexts that don't render a shell around this view. */
  onOpenSidebar?: () => void
}) {
  const [query, setQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<CategoryId | "all">("all")
  const [sortKey, setSortKey] = useState<SortKey>("recent")
  const [duplicatesOnly, setDuplicatesOnly] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openSelectedConfirmOpen, setOpenSelectedConfirmOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [categorySheetOpen, setCategorySheetOpen] = useState(false)
  const [depDialogFor, setDepDialogFor] = useState<string | null>(null)
  const [inspectTabId, setInspectTabId] = useState<string | null>(null)
  const [collapsedCollectionIds, setCollapsedCollectionIds] = useState<Set<string>>(new Set())
  const [gatherDialogTabIds, setGatherDialogTabIds] = useState<string[] | null>(null)
  const [renameCollectionId, setRenameCollectionId] = useState<string | null>(null)
  const [deleteCollectionId, setDeleteCollectionId] = useState<string | null>(null)
  const [addToCollectionId, setAddToCollectionId] = useState<string | null>(null)
  const [openAllCollectionId, setOpenAllCollectionId] = useState<string | null>(null)
  const [recentlyGatheredIds, setRecentlyGatheredIds] = useState<Set<string>>(new Set())
  const recentlyGatheredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (recentlyGatheredTimerRef.current) clearTimeout(recentlyGatheredTimerRef.current)
    }
  }, [])

  function markRecentlyGathered(ids: string[]) {
    if (ids.length === 0) return
    setRecentlyGatheredIds(new Set(ids))
    if (recentlyGatheredTimerRef.current) clearTimeout(recentlyGatheredTimerRef.current)
    recentlyGatheredTimerRef.current = setTimeout(() => setRecentlyGatheredIds(new Set()), 6000)
  }

  const workspaceId = currentWorkspace?.id ?? ""

  // Falls back to just this workspace's own tabs when the caller doesn't
  // pass allWorkspaces (some embedded/test contexts don't) — dependencies
  // still work, just scoped to what's actually available rather than every
  // workspace in the store.
  const depScopeWorkspaces = useMemo(
    () => allWorkspaces ?? (currentWorkspace ? [currentWorkspace] : [{ id: workspaceId, name: "", tabs, createdAt: 0, updatedAt: 0 }]),
    [allWorkspaces, currentWorkspace, workspaceId, tabs]
  )
  const depValidTabIds = useMemo(
    () => new Set(depScopeWorkspaces.flatMap((w) => w.tabs.map((t) => t.id))),
    [depScopeWorkspaces]
  )
  const {
    dependencies,
    addDependency: storeAddDependency,
    removeDependency: storeRemoveDependency,
    updateDependencyType: storeUpdateDependencyType,
  } = useDependencyStore(depValidTabIds)

  const {
    collections: allCollections,
    createCollection: createCollectionStore,
    renameCollection: renameCollectionStore,
    deleteCollection: deleteCollectionStore,
    addTabToCollection: addTabToCollectionStore,
    addTabsToCollection: addTabsToCollectionStore,
    removeTabFromCollection: removeTabFromCollectionStore,
    moveTabToCollection: moveTabToCollectionStore,
  } = useCollectionStore(depScopeWorkspaces)
  const workspaceCollections = useMemo(
    () => getCollectionsForWorkspace(allCollections, workspaceId),
    [allCollections, workspaceId]
  )
  const tabsById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs])
  // Tab id → collection name, for the "Collection: X" line shown in search
  // results (progressive disclosure — see tab-card.tsx's collectionName prop).
  const tabCollectionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of workspaceCollections) for (const id of c.tabIds) map.set(id, c.name)
    return map
  }, [workspaceCollections])
  const expandedCollectionIds = useMemo(
    () => new Set(workspaceCollections.map((c) => c.id).filter((id) => !collapsedCollectionIds.has(id))),
    [workspaceCollections, collapsedCollectionIds]
  )
  const renameCollectionTarget = renameCollectionId
    ? (workspaceCollections.find((c) => c.id === renameCollectionId) ?? null)
    : null
  const deleteCollectionTarget = deleteCollectionId
    ? (workspaceCollections.find((c) => c.id === deleteCollectionId) ?? null)
    : null
  const addToCollectionTarget = addToCollectionId
    ? (workspaceCollections.find((c) => c.id === addToCollectionId) ?? null)
    : null
  const openAllCollectionTarget = openAllCollectionId
    ? (workspaceCollections.find((c) => c.id === openAllCollectionId) ?? null)
    : null

  function handleToggleCollectionExpanded(id: string) {
    setCollapsedCollectionIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleNewCollection() {
    setGatherDialogTabIds([])
  }

  function handleGatherSelected() {
    setGatherDialogTabIds([...selectedIds])
  }

  function handleGatherConfirm(name: string) {
    const gatheredIds = gatherDialogTabIds ?? []
    const collection = createCollectionStore(workspaceId, name, gatheredIds)
    setCollapsedCollectionIds((prev) => {
      if (!prev.has(collection.id)) return prev
      const next = new Set(prev)
      next.delete(collection.id)
      return next
    })
    if (gatheredIds.length > 0) {
      toast.success(`Gathered ${gatheredIds.length} tab${gatheredIds.length === 1 ? "" : "s"} into "${name}"`)
      markRecentlyGathered(gatheredIds)
      exitSelectionMode()
    } else {
      toast.success(`Created "${name}"`)
    }
    setGatherDialogTabIds(null)
  }

  function handleAddSelectedToCollection(collectionId: string) {
    const ids = [...selectedIds]
    addTabsToCollectionStore(collectionId, ids)
    const name = workspaceCollections.find((c) => c.id === collectionId)?.name ?? "collection"
    toast.success(`Added ${ids.length} tab${ids.length === 1 ? "" : "s"} to ${name}`)
    markRecentlyGathered(ids)
    exitSelectionMode()
  }

  function handleAddTabsRequest(collectionId: string) {
    const name = workspaceCollections.find((c) => c.id === collectionId)?.name ?? "this collection"
    setAddToCollectionId(collectionId)
    setSelectionMode(true)
    setSelectedIds(new Set())
    toast.info(`Select tabs to add to "${name}", then confirm below.`)
  }

  function handleConfirmAddToCollection() {
    if (!addToCollectionId) return
    handleAddSelectedToCollection(addToCollectionId)
  }

  function handleRenameCollectionConfirm(name: string) {
    if (renameCollectionId) renameCollectionStore(renameCollectionId, name)
    setRenameCollectionId(null)
  }

  function handleDeleteCollectionConfirm() {
    if (deleteCollectionId) {
      deleteCollectionStore(deleteCollectionId)
      toast.success("Collection deleted")
    }
    setDeleteCollectionId(null)
  }

  function handleRemoveTabFromCollection(collectionId: string, tabId: string) {
    removeTabFromCollectionStore(collectionId, tabId)
    toast.success("Removed from collection")
  }

  function handleMoveTabToCollection(tabId: string, collectionId: string) {
    moveTabToCollectionStore(tabId, collectionId)
    const name = workspaceCollections.find((c) => c.id === collectionId)?.name ?? "collection"
    toast.success(`Moved to ${name}`)
  }

  function handleDropTabOnCollection(collectionId: string, tabId: string) {
    const collection = workspaceCollections.find((c) => c.id === collectionId)
    if (!collection) return
    const tabWorkspaceId = tabsById.has(tabId) ? workspaceId : undefined
    const validation = validateAddTabToCollection(allCollections, collectionId, tabId, tabWorkspaceId)
    if (!validation.ok) {
      if (validation.reason !== "duplicate") toast.error("Couldn't add that tab to the collection")
      return
    }
    addTabToCollectionStore(collectionId, tabId)
    toast.success(`Added to ${collection.name}`)
  }

  function openAllInCollection(id: string) {
    const collection = workspaceCollections.find((c) => c.id === id)
    if (!collection) return
    const collectionTabs = getCollectionTabs(collection, tabsById)
    collectionTabs.forEach((t) => openTab(t.url, { newTab: true }))
  }

  function handleOpenAllInCollection(id: string) {
    const collection = workspaceCollections.find((c) => c.id === id)
    if (!collection) return
    if (collection.tabIds.length > OPEN_SELECTED_CONFIRM_THRESHOLD) {
      setOpenAllCollectionId(id)
      return
    }
    openAllInCollection(id)
  }

  async function handleExportCollection(id: string) {
    const collection = workspaceCollections.find((c) => c.id === id)
    if (!collection) return
    const collectionTabs = getCollectionTabs(collection, tabsById)
    const ok = await copyText(urlsText(collectionTabs))
    if (ok) toast.success(`Copied ${collectionTabs.length} URL${collectionTabs.length === 1 ? "" : "s"}`)
    else toast.error("Couldn't copy to clipboard")
  }

  const depWorkspaceLookup = useMemo(() => buildWorkspaceLookup(depScopeWorkspaces), [depScopeWorkspaces])
  const depCandidateNodes = useMemo(
    () => buildGraphNodes(depScopeWorkspaces.flatMap((w) => w.tabs), depWorkspaceLookup),
    [depScopeWorkspaces, depWorkspaceLookup]
  )
  const depSourceNode = depDialogFor ? (depCandidateNodes.find((n) => n.id === depDialogFor) ?? null) : null
  const depCandidates = useMemo(
    () => depCandidateNodes.filter((n) => n.id !== depDialogFor),
    [depCandidateNodes, depDialogFor]
  )
  const depExistingTargetIds = useMemo(
    () => (depDialogFor ? new Set(dependenciesOf(depDialogFor, dependencies).map((d) => d.childTabId)) : undefined),
    [depDialogFor, dependencies]
  )
  const depNodeById = useMemo(() => new Map(depCandidateNodes.map((n) => [n.id, n])), [depCandidateNodes])

  const inspectNode = inspectTabId ? (depNodeById.get(inspectTabId) ?? null) : null
  const inspectDependencies = useMemo(
    () => (inspectTabId ? dependenciesOf(inspectTabId, dependencies) : []),
    [inspectTabId, dependencies]
  )
  const inspectUsedBy = useMemo(
    () => (inspectTabId ? usedBy(inspectTabId, dependencies) : []),
    [inspectTabId, dependencies]
  )
  const inspectTree = useMemo(
    () => (inspectTabId ? buildDependencyTree(inspectTabId, dependencies, depValidTabIds) : []),
    [inspectTabId, dependencies, depValidTabIds]
  )

  function handleAddDependencyConfirmed(childTabId: string, type: DependencyType | undefined) {
    if (!depDialogFor) return
    const validation = validateDependency(dependencies, depDialogFor, childTabId)
    if (!validation.ok) {
      toast.info(validation.reason === "self" ? "A tab can't depend on itself" : "Already a dependency")
      return
    }
    storeAddDependency(depDialogFor, childTabId, type)
    toast.success("Dependency added")
  }

  function handleRemoveDependency(depId: string) {
    storeRemoveDependency(depId)
    toast.success("Dependency removed")
  }

  // Compact "↓ N dependencies · ↑ M used by" indicator shown under a tab in
  // search/filter results (FilteredTabList) — see tab-dependency-indicator.tsx.
  // Reuses the same dependency store/lookup data the dependency dialog above
  // already computes; nothing here duplicates that state. A dependency whose
  // other-end tab can't be resolved via depNodeById (a stale reference the
  // hook hasn't pruned yet, or one outside depScopeWorkspaces) is silently
  // skipped rather than shown broken.
  const dependenciesByParent = useMemo(() => groupDependenciesByParent(dependencies), [dependencies])
  const dependenciesByChild = useMemo(() => groupDependenciesByChild(dependencies), [dependencies])
  const dependencyIndicators = useMemo(() => {
    const map = new Map<string, DependencyIndicatorData>()
    for (const tab of tabs) {
      const outgoing = dependenciesByParent.get(tab.id) ?? [];
      const incoming = dependenciesByChild.get(tab.id) ?? [];
      if (outgoing.length === 0 && incoming.length === 0) continue
      const toItem = (id: string) => {
        const node = depNodeById.get(id)
        return node ? { id, label: node.tab.title?.trim() || node.tab.domain } : null
      }
      map.set(tab.id, {
        dependencies: outgoing.map((d) => toItem(d.childTabId)).filter((item) => item !== null),
        usedBy: incoming.map((d) => toItem(d.parentTabId)).filter((item) => item !== null),
      })
    }
    return map
  }, [tabs, dependenciesByParent, dependenciesByChild, depNodeById])

  // "Select" reuses the existing search/filter mechanism (the same behavior
  // a user gets from typing in the search box) rather than introducing a new
  // selection concept — searching by the tab's exact URL narrows the list
  // down to it. A stale id (depNodeById lookup fails) is a safe no-op.
  function handleSelectDependencyTab(id: string) {
    const node = depNodeById.get(id)
    if (!node) return
    setCategoryFilter("all")
    setDuplicatesOnly(false)
    handleSearch(node.tab.url)
  }

  function handleOpenDependencyTab(id: string) {
    const node = depNodeById.get(id)
    if (!node) return
    openTab(node.tab.url)
  }
  // AI indexing (Gemini embeddings) only needs to run once something that
  // actually reads the resulting index has been opened — the Ask TabDump
  // panel, or a category sheet whose "Understand this collection"/"Find
  // gaps" buttons are now reachable. Never on every workspace view, whether
  // or not the user ever touches an AI feature — see use-ai-indexing.ts.
  const indexState = useAiIndexing(workspaceId, tabs, askOpen || categorySheetOpen)

  const isBrowsing =
    query.trim() === "" && categoryFilter === "all" && sortKey === "recent" && !duplicatesOnly

  // Searching a collection's name also surfaces its member tabs, in addition
  // to whatever filterTabs already matches on title/domain/url/category —
  // still gated by the active category filter/duplicates-only toggle so a
  // collection match never bypasses the rest of the search UI's filters.
  const collectionQueryMatchIds = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const ids = new Set<string>()
    for (const c of workspaceCollections) {
      if (c.name.toLowerCase().includes(q)) for (const id of c.tabIds) ids.add(id)
    }
    return ids.size > 0 ? ids : null
  }, [workspaceCollections, query])

  const resultTabs = useMemo(() => {
    const base = filterTabs(tabs, { query, categoryId: categoryFilter, duplicatesOnly })
    if (!collectionQueryMatchIds) return sortTabs(base, sortKey)
    const baseIds = new Set(base.map((t) => t.id))
    const extra = tabs.filter(
      (t) =>
        collectionQueryMatchIds.has(t.id) &&
        !baseIds.has(t.id) &&
        (categoryFilter === "all" || ((t.category as CategoryId | undefined) ?? "other") === categoryFilter) &&
        (!duplicatesOnly || Boolean(t.isDuplicate))
    )
    return sortTabs([...base, ...extra], sortKey)
  }, [tabs, query, categoryFilter, sortKey, duplicatesOnly, collectionQueryMatchIds])

  const attention = useMemo(() => computeAttention(tabs), [tabs])

  function handleSearch(value: string) {
    setQuery(value)
    setHighlightedIndex(0)
  }

  function handleCategoryFilter(value: CategoryId | "all") {
    setCategoryFilter(value)
    setHighlightedIndex(0)
  }

  function handleSort(value: SortKey) {
    setSortKey(value)
    setHighlightedIndex(0)
  }

  function resetFilters() {
    setQuery("")
    setCategoryFilter("all")
    setSortKey("recent")
    setDuplicatesOnly(false)
  }

  function handleCategoryChange(id: string, category: CategoryId) {
    onTabsChange(tabs.map((t) => (t.id === id ? { ...t, category } : t)))
  }

  function handleNotesChange(id: string, notes: string) {
    const trimmed = notes.trim()
    onTabsChange(tabs.map((t) => (t.id === id ? { ...t, notes: trimmed || undefined } : t)))
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelectionMode() {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setAddToCollectionId(null)
  }

  const OPEN_SELECTED_CONFIRM_THRESHOLD = 10

  function handleRecategorizeSelected(category: CategoryId) {
    const ids = selectedIds
    onTabsChange(tabs.map((t) => (ids.has(t.id) ? { ...t, category } : t)))
    toast.success(
      `Recategorized ${ids.size} tab${ids.size === 1 ? "" : "s"} to ${CATEGORIES[category].name}`
    )
    exitSelectionMode()
  }

  async function handleExportSelected() {
    const selected = tabs.filter((t) => selectedIds.has(t.id))
    const ok = await copyText(urlsText(selected))
    if (ok) toast.success(`Copied ${selected.length} URL${selected.length === 1 ? "" : "s"}`)
    else toast.error("Couldn't copy to clipboard")
  }

  function openSelectedTabs() {
    const selected = tabs.filter((t) => selectedIds.has(t.id))
    selected.forEach((t) => openTab(t.url, { newTab: true }))
  }

  function handleOpenSelected() {
    if (selectedIds.size > OPEN_SELECTED_CONFIRM_THRESHOLD) {
      setOpenSelectedConfirmOpen(true)
      return
    }
    openSelectedTabs()
  }

  function handleRemoveSelected() {
    const remaining = removeTabs(tabs, Array.from(selectedIds))
    onTabsChange(remaining)
    toast.success(`Removed ${selectedIds.size} tab${selectedIds.size === 1 ? "" : "s"}.`)
    exitSelectionMode()
  }

  function handleRemoveDuplicates(ids: string[]) {
    if (ids.length === 0) return
    const remaining = removeTabs(tabs, ids)
    onTabsChange(remaining)
    toast.success(
      `Removed ${ids.length} duplicate tab${ids.length === 1 ? "" : "s"}.`,
      {
        description: `${remaining.length} tab${remaining.length === 1 ? "" : "s"} remain.`,
      }
    )
  }

  async function handleExportAll() {
    const ok = await copyText(urlsText(tabs))
    if (ok) toast.success(`Copied ${tabs.length} URL${tabs.length === 1 ? "" : "s"}`)
    else toast.error("Couldn't copy to clipboard")
  }

  async function handleExportCategory(id: CategoryId) {
    const categoryTabs = tabs.filter(
      (t) => ((t.category as CategoryId | undefined) ?? "other") === id
    )
    const ok = await copyText(urlsText(categoryTabs))
    if (ok) toast.success(`Copied ${categoryTabs.length} URL${categoryTabs.length === 1 ? "" : "s"}`)
    else toast.error("Couldn't copy to clipboard")
  }

  const askCommands: Command[] = [
    {
      id: "ask-open",
      label: "Ask TabDump…",
      group: "Ask",
      icon: Sparkles,
      onSelect: () => setAskOpen(true),
    },
  ]

  const navigationCommands: Command[] = [
    {
      id: "nav-search",
      label: "Search tabs",
      group: "Navigation",
      icon: SearchIcon,
      shortcut: ["/"],
      onSelect: () => document.getElementById("workspace-search-input")?.focus(),
    },
    {
      id: "nav-show-all",
      label: "Show all tabs",
      group: "Navigation",
      icon: LayoutGrid,
      onSelect: resetFilters,
    },
    {
      id: "nav-show-duplicates",
      label: "Show duplicates",
      group: "Navigation",
      icon: DuplicatesIcon,
      onSelect: () => {
        setQuery("")
        setCategoryFilter("all")
        setDuplicatesOnly(true)
      },
    },
    ...(onOpenGraph
      ? [
          {
            id: "nav-open-graph",
            label: "Open graph view",
            group: "Navigation",
            icon: Waypoints,
            onSelect: onOpenGraph,
          } satisfies Command,
        ]
      : []),
    ...CATEGORY_ORDER.map(
      (id): Command => ({
        id: `nav-category-${id}`,
        label: `Go to ${CATEGORIES[id].name}`,
        group: "Navigation",
        icon: CATEGORIES[id].icon,
        onSelect: () => {
          setQuery("")
          setDuplicatesOnly(false)
          setCategoryFilter(id)
        },
      })
    ),
  ]

  const workspaceCommands: Command[] =
    onSwitchWorkspace && allWorkspaces
      ? allWorkspaces
          .filter((w) => w.id !== workspaceId)
          .map(
            (w): Command => ({
              id: `workspace-switch-${w.id}`,
              label: `Switch to ${w.name}`,
              group: "Workspace",
              icon: Layers,
              onSelect: () => onSwitchWorkspace(w.id),
            })
          )
      : []

  const selectionCommands: Command[] = [
    {
      id: "selection-toggle",
      label: selectionMode ? "Exit selection mode" : "Select tabs",
      group: "Selection",
      icon: CheckSquare,
      onSelect: () => (selectionMode ? exitSelectionMode() : setSelectionMode(true)),
    },
    {
      id: "selection-select-all",
      label: "Select all visible",
      group: "Selection",
      icon: CheckSquare,
      disabled: !selectionMode,
      onSelect: () => setSelectedIds(new Set(resultTabs.map((t) => t.id))),
    },
  ]

  const collectionCommands: Command[] = [
    {
      id: "collection-new",
      label: "New collection",
      group: "Collections",
      icon: Layers,
      onSelect: handleNewCollection,
    },
    {
      id: "collection-gather-selected",
      label: "Gather selected tabs",
      group: "Collections",
      icon: Layers,
      disabled: !(selectionMode && selectedIds.size > 0),
      onSelect: handleGatherSelected,
    },
    ...workspaceCollections.flatMap(
      (c): Command[] => [
        {
          id: `collection-rename-${c.id}`,
          label: `Rename "${c.name}"`,
          group: "Collections",
          icon: Pencil,
          onSelect: () => setRenameCollectionId(c.id),
        },
        {
          id: `collection-open-all-${c.id}`,
          label: `Open all in "${c.name}"`,
          group: "Collections",
          icon: OpenAllIcon,
          disabled: c.tabIds.length === 0,
          onSelect: () => handleOpenAllInCollection(c.id),
        },
        {
          id: `collection-delete-${c.id}`,
          label: `Delete "${c.name}"`,
          group: "Collections",
          icon: Trash2,
          onSelect: () => setDeleteCollectionId(c.id),
        },
      ]
    ),
  ]

  const counts = categoryCounts(tabs)

  const actionCommands: Command[] = [
    {
      id: "action-cleanup",
      label: "Cleanup duplicates",
      group: "Actions",
      icon: Sparkles,
      onSelect: () => setCleanupOpen(true),
    },
    {
      id: "action-export-all",
      label: "Export all tabs",
      group: "Actions",
      icon: Download,
      onSelect: handleExportAll,
    },
    ...CATEGORY_ORDER.map(
      (id): Command => ({
        id: `action-export-${id}`,
        label: `Export ${CATEGORIES[id].name}`,
        group: "Actions",
        icon: Download,
        disabled: (counts[id] ?? 0) === 0,
        onSelect: () => handleExportCategory(id),
      })
    ),
    {
      id: "action-clear",
      label: "Clear workspace",
      group: "Actions",
      icon: Trash2,
      onSelect: () => setClearConfirmOpen(true),
    },
  ]

  const sortCommands: Command[] = (["recent", "title", "domain", "category"] as const).map(
    (key) => ({
      id: `sort-${key}`,
      label: `Sort by ${SORT_LABELS[key]}`,
      group: "Sort",
      icon: ArrowUpDown,
      onSelect: () => handleSort(key),
    })
  )

  const helpCommands: Command[] = [
    {
      id: "help-shortcuts",
      label: "Keyboard shortcuts",
      group: "Help",
      icon: Keyboard,
      shortcut: ["⌘", "K"],
      onSelect: () => setShortcutsOpen(true),
    },
  ]

  const allCommands = [
    ...askCommands,
    ...navigationCommands,
    ...workspaceCommands,
    ...selectionCommands,
    ...collectionCommands,
    ...actionCommands,
    ...sortCommands,
    ...helpCommands,
  ]

  useWorkspaceShortcuts({
    onOpenPalette: () => setCommandPaletteOpen(true),
    onFocusSearch: () => document.getElementById("workspace-search-input")?.focus(),
    onEscape: () => {
      if (commandPaletteOpen) return setCommandPaletteOpen(false)
      if (askOpen) return setAskOpen(false)
      if (shortcutsOpen) return setShortcutsOpen(false)
      if (cleanupOpen) return setCleanupOpen(false)
      if (clearConfirmOpen) return setClearConfirmOpen(false)
      if (gatherDialogTabIds !== null) return setGatherDialogTabIds(null)
      if (renameCollectionId !== null) return setRenameCollectionId(null)
      if (deleteCollectionId !== null) return setDeleteCollectionId(null)
      if (openAllCollectionId !== null) return setOpenAllCollectionId(null)
      if (openSelectedConfirmOpen) return setOpenSelectedConfirmOpen(false)
      if (selectionMode) return exitSelectionMode()
      if (query) return setQuery("")
    },
    onSelectAll: selectionMode
      ? () => setSelectedIds(new Set(resultTabs.map((t) => t.id)))
      : undefined,
  })

  return (
    <div
      className="min-h-screen"
      style={{ animation: "spatial-enter var(--duration-slow) var(--ease-standard) both" }}
    >
      <WorkspaceHeader
        tabs={tabs}
        searchValue={query}
        onSearch={handleSearch}
        onSearchArrowDown={() =>
          setHighlightedIndex((i) => Math.min(i + 1, resultTabs.length - 1))
        }
        onSearchArrowUp={() => setHighlightedIndex((i) => Math.max(i - 1, 0))}
        onSearchEnter={() => {
          const target = resultTabs[highlightedIndex]
          if (target) openTab(target.url)
        }}
        onCleanup={() => setCleanupOpen(true)}
        onRequestClear={() => setClearConfirmOpen(true)}
        onOpenPalette={() => setCommandPaletteOpen(true)}
        onOpenAsk={() => setAskOpen(true)}
        onOpenGraph={onOpenGraph}
        onOpenSidebar={onOpenSidebar}
        currentWorkspace={currentWorkspace}
        allWorkspaces={allWorkspaces}
        dependencies={dependencies}
        collections={allCollections}
      />
      <main
        className="mx-auto max-w-6xl"
        // Settings → Appearance → Layout → Spacing (see --tabdump-density-scale in resolve.ts).
        style={{
          paddingInline: "calc(1.5rem * var(--tabdump-density-scale, 1))",
          paddingBlock: "calc(2rem * var(--tabdump-density-scale, 1))",
        }}
      >
        <AttentionStrip
          attention={attention}
          onCleanup={() => setCleanupOpen(true)}
          onViewOther={() => handleCategoryFilter("other")}
        />
        <div className={attention ? "mt-6" : undefined}>
          <WorkspaceOverview tabs={tabs} />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <CategoryFilterBar tabs={tabs} value={categoryFilter} onChange={handleCategoryFilter} />
          <div className="flex items-center gap-2">
            {!isBrowsing &&
              (selectionMode ? (
                <Button variant="ghost" size="sm" onClick={exitSelectionMode}>
                  <X /> Cancel
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setSelectionMode(true)}>
                  <CheckSquare /> Select
                </Button>
              ))}
            <SortControl value={sortKey} onChange={handleSort} />
          </div>
        </div>

        {selectionMode && (selectedIds.size > 0 || addToCollectionTarget) && (
          <div className="mt-4">
            <SelectionToolbar
              count={selectedIds.size}
              onRecategorize={handleRecategorizeSelected}
              onExportSelected={handleExportSelected}
              onOpenSelected={handleOpenSelected}
              onRemoveSelected={handleRemoveSelected}
              onClear={exitSelectionMode}
              collections={workspaceCollections.map((c) => ({ id: c.id, name: c.name }))}
              onAddToCollection={handleAddSelectedToCollection}
              onGatherNew={handleGatherSelected}
              addToCollectionTarget={
                addToCollectionTarget
                  ? { name: addToCollectionTarget.name, onConfirm: handleConfirmAddToCollection }
                  : undefined
              }
            />
          </div>
        )}

        <div className="mt-6 space-y-6">
          {/* Rendered regardless of isBrowsing (not just on the default
             view) so a collection is always a visible drop target — a tab
             that isn't gathered yet only ever appears as a draggable row
             inside search/filter results (FilteredTabList) or a category
             sheet, never inside CategoryGrid's aggregate cards, so dragging
             one into a collection requires both to be on screen together. */}
          <CollectionsSection
            collections={workspaceCollections}
            tabsById={tabsById}
            expandedIds={expandedCollectionIds}
            onToggleExpanded={handleToggleCollectionExpanded}
            onCategoryChange={handleCategoryChange}
            onNewCollection={handleNewCollection}
            onRename={(id) => setRenameCollectionId(id)}
            onAddTabs={handleAddTabsRequest}
            onOpenAll={handleOpenAllInCollection}
            onExport={handleExportCollection}
            onDelete={(id) => setDeleteCollectionId(id)}
            onRemoveTab={handleRemoveTabFromCollection}
            onMoveTab={handleMoveTabToCollection}
            onDropTab={handleDropTabOnCollection}
            onAddDependency={setDepDialogFor}
            onInspect={setInspectTabId}
            onNotesChange={handleNotesChange}
            dependencyIndicators={dependencyIndicators}
            onSelectDependencyTab={handleSelectDependencyTab}
            onOpenDependencyTab={handleOpenDependencyTab}
            recentlyAddedIds={recentlyGatheredIds}
          />

          {isBrowsing ? (
            <CategoryGrid
              tabs={tabs}
              onCategoryChange={handleCategoryChange}
              workspaceId={workspaceId}
              onSheetOpenChange={setCategorySheetOpen}
              onAddDependency={setDepDialogFor}
              onInspect={setInspectTabId}
              onNotesChange={handleNotesChange}
              recentlyAddedIds={recentlyAddedIds}
            />
          ) : (
            <FilteredTabList
              tabs={resultTabs}
              highlightedIndex={highlightedIndex}
              onCategoryChange={handleCategoryChange}
              onClearFilters={resetFilters}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onAddDependency={setDepDialogFor}
              onInspect={setInspectTabId}
              onNotesChange={handleNotesChange}
              dependencyIndicators={dependencyIndicators}
              collectionNames={tabCollectionNames}
              onSelectDependencyTab={handleSelectDependencyTab}
              onOpenDependencyTab={handleOpenDependencyTab}
              recentlyAddedIds={recentlyAddedIds}
            />
          )}
        </div>
      </main>

      <CleanupDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        tabs={tabs}
        onRemove={handleRemoveDuplicates}
      />

      <ClearWorkspaceDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        onConfirm={() => {
          setClearConfirmOpen(false)
          onClear()
        }}
      />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      <AlertDialog open={openSelectedConfirmOpen} onOpenChange={setOpenSelectedConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open {selectedIds.size} tabs?</AlertDialogTitle>
            <AlertDialogDescription>
              Your browser may block or slow down opening this many tabs at once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpenSelectedConfirmOpen(false)
                openSelectedTabs()
              }}
            >
              Open tabs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={allCommands}
      />

      <GatherDialog
        open={gatherDialogTabIds !== null}
        onOpenChange={(open) => {
          if (!open) setGatherDialogTabIds(null)
        }}
        tabCount={gatherDialogTabIds?.length ?? 0}
        onConfirm={handleGatherConfirm}
      />

      {renameCollectionTarget && (
        <RenameCollectionDialog
          key={renameCollectionTarget.id}
          open={renameCollectionId !== null}
          onOpenChange={(open) => {
            if (!open) setRenameCollectionId(null)
          }}
          currentName={renameCollectionTarget.name}
          onRename={handleRenameCollectionConfirm}
        />
      )}

      {deleteCollectionTarget && (
        <DeleteCollectionDialog
          open={deleteCollectionId !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteCollectionId(null)
          }}
          collectionName={deleteCollectionTarget.name}
          tabCount={deleteCollectionTarget.tabIds.length}
          onConfirm={handleDeleteCollectionConfirm}
        />
      )}

      <AlertDialog open={openAllCollectionId !== null} onOpenChange={(open) => !open && setOpenAllCollectionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open {openAllCollectionTarget?.tabIds.length ?? 0} tabs?</AlertDialogTitle>
            <AlertDialogDescription>
              Your browser may block or slow down opening this many tabs at once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (openAllCollectionId) openAllInCollection(openAllCollectionId)
                setOpenAllCollectionId(null)
              }}
            >
              Open tabs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AskTabDumpPanel
        open={askOpen}
        onOpenChange={setAskOpen}
        workspaceId={workspaceId}
        tabs={tabs}
        indexState={indexState}
        allWorkspaces={allWorkspaces}
        onStoreUpdate={onStoreUpdate}
      />

      <GraphLinkDialog
        open={depDialogFor !== null}
        onOpenChange={(open) => {
          if (!open) setDepDialogFor(null)
        }}
        mode="dependency"
        sourceNode={depSourceNode}
        candidates={depCandidates}
        existingDependencyTargetIds={depExistingTargetIds}
        onAddDependency={handleAddDependencyConfirmed}
      />

      <TabInspector
        open={inspectTabId !== null}
        onOpenChange={(open) => {
          if (!open) setInspectTabId(null)
        }}
        node={inspectNode}
        dependencies={inspectDependencies}
        usedByDeps={inspectUsedBy}
        tree={inspectTree}
        nodeById={depNodeById}
        onSelectTab={setInspectTabId}
        onOpenTab={handleOpenDependencyTab}
        onAddDependency={() => inspectTabId && setDepDialogFor(inspectTabId)}
        onRemoveDependency={handleRemoveDependency}
        onChangeDependencyType={storeUpdateDependencyType}
      />
    </div>
  )
}
