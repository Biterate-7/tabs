import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export type Attention =
  | { kind: "duplicates"; count: number }
  | { kind: "uncategorized"; count: number; share: number }
  | null

const UNCATEGORIZED_SHARE_THRESHOLD = 0.5
const UNCATEGORIZED_MIN_COUNT = 3

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other"
}

export function computeAttention(tabs: Tab[]): Attention {
  const duplicateCount = tabs.filter((t) => t.isDuplicate).length
  if (duplicateCount > 0) {
    return { kind: "duplicates", count: duplicateCount }
  }

  const total = tabs.length
  if (total === 0) return null

  const otherCount = tabs.filter((t) => categoryOf(t) === "other").length
  const share = otherCount / total

  if (otherCount >= UNCATEGORIZED_MIN_COUNT && share >= UNCATEGORIZED_SHARE_THRESHOLD) {
    return { kind: "uncategorized", count: otherCount, share }
  }

  return null
}
