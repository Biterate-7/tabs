"use client"

import { useMemo, useState } from "react"
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
} from "lucide-react"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { CleanupDialog } from "@/components/workspace/cleanup-dialog"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"
import { ShortcutsDialog } from "@/components/workspace/shortcuts-dialog"
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
import { filterTabs, sortTabs, categoryCounts } from "@/lib/workspace/search"
import type { SortKey } from "@/lib/workspace/search"
import { copyText, urlsText } from "@/lib/workspace/export"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { useWorkspaceShortcuts } from "@/hooks/use-workspace-shortcuts"
import type { Tab } from "@/lib/tabs/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

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
}: {
  tabs: Tab[]
  onTabsChange: (tabs: Tab[]) => void
  onClear: () => void
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

  const allCommands = [...navigationCommands, ...actionCommands, ...sortCommands, ...helpCommands]

  useWorkspaceShortcuts({
    onOpenPalette: () => setCommandPaletteOpen(true),
    onFocusSearch: () => document.getElementById("workspace-search-input")?.focus(),
    onEscape: () => {
      if (commandPaletteOpen) return setCommandPaletteOpen(false)
      if (shortcutsOpen) return setShortcutsOpen(false)
      if (cleanupOpen) return setCleanupOpen(false)
      if (clearConfirmOpen) return setClearConfirmOpen(false)
      if (query) return setQuery("")
    },
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
          <SortControl value={sortKey} onChange={handleSort} />
        </div>

        <div className="mt-6">
          {isBrowsing ? (
            <CategoryGrid tabs={tabs} onCategoryChange={handleCategoryChange} />
          ) : (
            <FilteredTabList
              tabs={resultTabs}
              highlightedIndex={highlightedIndex}
              onCategoryChange={handleCategoryChange}
              onClearFilters={resetFilters}
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

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        commands={allCommands}
      />
    </div>
  )
}
