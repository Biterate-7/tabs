import { CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { groupByCategory } from "./stats"

export type CategoryPresence = "large" | "standard" | "compact"

export type CategoryHierarchyEntry = {
  id: CategoryId
  tabs: Tab[]
  presence: CategoryPresence
}

const LARGE_SHARE_THRESHOLD = 0.2
const COMPACT_MAX_COUNT = 1

export function orderCategoriesByPresence(tabs: Tab[]): CategoryHierarchyEntry[] {
  const groups = groupByCategory(tabs)
  const total = tabs.length

  const ordered: CategoryId[] = CATEGORY_ORDER.filter((id) => id !== "other")
  ordered.sort((a, b) => groups[b].length - groups[a].length)
  ordered.push("other")

  return ordered.map((id): CategoryHierarchyEntry => {
    const categoryTabs = groups[id]
    const count = categoryTabs.length
    const share = total > 0 ? count / total : 0

    let presence: CategoryPresence = "standard"
    if (count <= COMPACT_MAX_COUNT) presence = "compact"
    else if (share >= LARGE_SHARE_THRESHOLD) presence = "large"

    return { id, tabs: categoryTabs, presence }
  })
}
