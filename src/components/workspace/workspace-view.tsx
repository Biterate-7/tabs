"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { CleanupDialog } from "@/components/workspace/cleanup-dialog"
import { removeTabs } from "@/lib/workspace/cleanup"
import { WorkspaceOverview } from "@/components/workspace/workspace-overview"
import { CategoryGrid } from "@/components/workspace/category-grid"
import { CategoryFilterBar } from "@/components/workspace/category-filter-bar"
import { SortControl } from "@/components/workspace/sort-control"
import { FilteredTabList } from "@/components/workspace/filtered-tab-list"
import { filterTabs, sortTabs } from "@/lib/workspace/search"
import type { SortKey } from "@/lib/workspace/search"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
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
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [cleanupOpen, setCleanupOpen] = useState(false)

  const isBrowsing = query.trim() === "" && categoryFilter === "all" && sortKey === "recent"

  const resultTabs = useMemo(
    () => sortTabs(filterTabs(tabs, { query, categoryId: categoryFilter }), sortKey),
    [tabs, query, categoryFilter, sortKey]
  )

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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        document.getElementById("workspace-search-input")?.focus()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

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
        onClear={onClear}
      />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <WorkspaceOverview tabs={tabs} />

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
    </div>
  )
}
