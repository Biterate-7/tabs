"use client"

import { useMemo, useState } from "react"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { WorkspaceOverview } from "@/components/workspace/workspace-overview"
import { CategoryGrid } from "@/components/workspace/category-grid"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

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

  const visibleTabs = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tabs
    return tabs.filter(
      (t) =>
        t.domain.toLowerCase().includes(q) ||
        (t.title ?? "").toLowerCase().includes(q)
    )
  }, [tabs, query])

  function handleCategoryChange(id: string, category: CategoryId) {
    onTabsChange(tabs.map((t) => (t.id === id ? { ...t, category } : t)))
  }

  function handleCleanup() {
    onTabsChange(tabs.filter((t) => !t.isDuplicate))
  }

  function handleExport() {
    const text = tabs.map((t) => t.url).join("\n")
    navigator.clipboard?.writeText(text)
  }

  return (
    <div className="min-h-screen">
      <WorkspaceHeader
        tabCount={tabs.length}
        searchValue={query}
        onSearch={setQuery}
        onCleanup={handleCleanup}
        onExport={handleExport}
        onClear={onClear}
      />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <WorkspaceOverview tabs={tabs} />
        <div className="mt-8">
          <CategoryGrid tabs={visibleTabs} onCategoryChange={handleCategoryChange} />
        </div>
      </main>
    </div>
  )
}
