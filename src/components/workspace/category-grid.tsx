"use client"

import { useState } from "react"
import { CategoryCard } from "@/components/workspace/category-card"
import { CategorySheet } from "@/components/workspace/category-sheet"
import { orderCategoriesByPresence } from "@/lib/workspace/hierarchy"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategoryGrid({
  tabs,
  onCategoryChange,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null)
  const entries = orderCategoriesByPresence(tabs)
  const groupsById = Object.fromEntries(entries.map((e) => [e.id, e.tabs])) as Record<
    CategoryId,
    Tab[]
  >

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <CategoryCard
            key={entry.id}
            categoryId={entry.id}
            tabs={entry.tabs}
            presence={entry.presence}
            onViewAll={() => setOpenCategory(entry.id)}
          />
        ))}
      </div>

      <CategorySheet
        categoryId={openCategory}
        tabs={openCategory ? groupsById[openCategory] : []}
        open={openCategory !== null}
        onOpenChange={(open) => !open && setOpenCategory(null)}
        onCategoryChange={onCategoryChange}
      />
    </>
  )
}
