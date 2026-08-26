"use client"

import { useMemo, useState, type ReactNode } from "react"
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
import type { Tab } from "@/lib/tabs/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"
import { openTab } from "@/lib/browser/open-tab"

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
  workspaceSwitcher,
  currentWorkspace,
  allWorkspaces,
  onStoreUpdate,
}: {
  tabs: Tab[]
  onTabsChange: (tabs: Tab[]) => void
  onClear: () => void
  workspaceSwitcher?: ReactNode
  currentWorkspace?: Workspace
  allWorkspaces?: Workspace[]
  /** Lets Ask TabDump's agent mode write back a store mutated by an action (create/rename workspace, move tabs, etc). */
  onStoreUpdate?: (store: WorkspaceStore) => void
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

  const workspaceId = currentWorkspace?.id ?? ""
  // AI indexing (Gemini embeddings) only needs to run once something that
  // actually reads the resulting index has been opened — the Ask TabDump
  // panel, or a category sheet whose "Understand this collection"/"Find
  // gaps" buttons are now reachable. Never on every workspace view, whether
  // or not the user ever touches an AI feature — see use-ai-indexing.ts.
  const indexState = useAiIndexing(workspaceId, tabs, askOpen || categorySheetOpen)

  const isBrowsing =
    query.trim() === "" && categoryFilter === "all" && sortKey === "recent" && !duplicatesOnly

  const resultTabs = useMemo(
    () =>
      sortTabs(filterTabs(tabs, { query, categoryId: categoryFilter, duplicatesOnly }), sortKey),
    [tabs, query, categoryFilter, sortKey, duplicatesOnly]
  )

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
    ...selectionCommands,
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
      if (openSelectedConfirmOpen) return setOpenSelectedConfirmOpen(false)
      if (selectionMode) return exitSelectionMode()
      if (query) return setQuery("")
    },
    onSelectAll: selectionMode
      ? () => setSelectedIds(new Set(resultTabs.map((t) => t.id)))
      : undefined,
  })

  return (
    <div className="min-h-screen">
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
        workspaceSwitcher={workspaceSwitcher}
        currentWorkspace={currentWorkspace}
        allWorkspaces={allWorkspaces}
      />
      <main className="mx-auto max-w-6xl px-6 py-8">
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

        {selectionMode && selectedIds.size > 0 && (
          <div className="mt-4">
            <SelectionToolbar
              count={selectedIds.size}
              onRecategorize={handleRecategorizeSelected}
              onExportSelected={handleExportSelected}
              onOpenSelected={handleOpenSelected}
              onRemoveSelected={handleRemoveSelected}
              onClear={exitSelectionMode}
            />
          </div>
        )}

        <div className="mt-6">
          {isBrowsing ? (
            <CategoryGrid
              tabs={tabs}
              onCategoryChange={handleCategoryChange}
              workspaceId={workspaceId}
              onSheetOpenChange={setCategorySheetOpen}
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

      <AskTabDumpPanel
        open={askOpen}
        onOpenChange={setAskOpen}
        workspaceId={workspaceId}
        tabs={tabs}
        indexState={indexState}
        allWorkspaces={allWorkspaces}
        onStoreUpdate={onStoreUpdate}
      />
    </div>
  )
}
