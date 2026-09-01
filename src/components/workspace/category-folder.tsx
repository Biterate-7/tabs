"use client"

import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import type { CategoryPresence } from "@/lib/workspace/hierarchy"
import { FolderTile } from "@/components/workspace/folder-tile"

export function CategoryFolder({
  categoryId,
  tabs,
  presence,
  onViewAll,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  presence: CategoryPresence
  onViewAll: () => void
}) {
  const def = CATEGORIES[categoryId]

  return (
    <FolderTile
      name={def.name}
      icon={def.icon}
      accentVar={def.accentColor}
      tabs={tabs}
      totalCount={tabs.length}
      presence={presence}
      onOpen={onViewAll}
    />
  )
}
