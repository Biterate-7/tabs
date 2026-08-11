"use client"

import { useState } from "react"
import { CategoryCard } from "@/components/workspace/category-card"
import { CategorySheet } from "@/components/workspace/category-sheet"
import { CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { groupByCategory } from "@/lib/workspace/stats"

export function CategoryGrid({
  tabs,
  onCategoryChange,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null)
  const groups = groupByCategory(tabs)

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CATEGORY_ORDER.map((id) => (
          <CategoryCard
            key={id}
            categoryId={id}
            tabs={groups[id]}
            onViewAll={() => setOpenCategory(id)}
          />
        ))}
      </div>

      <CategorySheet
        categoryId={openCategory}
        tabs={openCategory ? groups[openCategory] : []}
        open={openCategory !== null}
        onOpenChange={(open) => !open && setOpenCategory(null)}
        onCategoryChange={onCategoryChange}
      />
    </>
  )
}
