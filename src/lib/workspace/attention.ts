import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import type { Section } from "@/lib/sections/types"

export type Attention =
  | { kind: "duplicates"; count: number }
  | { kind: "uncategorized"; count: number; share: number }
  | null

const UNCATEGORIZED_SHARE_THRESHOLD = 0.5
const UNCATEGORIZED_MIN_COUNT = 3

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other"
}

/**
 * `sections` lets this measure "unorganized" the same way the hierarchical
 * folder view does (falls into the synthetic Other bucket — see
 * src/lib/sections/tree.ts) rather than by the legacy flat `category` field,
 * which the AI categorization pipeline (src/lib/sections/ai/pipeline.ts)
 * never touches. Without this, a workspace the pipeline had already
 * organized into real sections could still trip this banner purely because
 * each tab's untouched legacy category happened to be "other" — exactly the
 * false alarm this pipeline exists to eliminate. Omit `sections` (or pass
 * `undefined`) for a workspace that predates sections entirely, in which
 * case the legacy category is the only signal available.
 */
export function computeAttention(tabs: Tab[], sections?: Section[]): Attention {
  const duplicateCount = tabs.filter((t) => t.isDuplicate).length
  if (duplicateCount > 0) {
    return { kind: "duplicates", count: duplicateCount }
  }

  const total = tabs.length
  if (total === 0) return null

  const otherCount =
    sections !== undefined
      ? tabs.filter((t) => !t.sectionId || !sections.some((s) => s.id === t.sectionId)).length
      : tabs.filter((t) => categoryOf(t) === "other").length
  const share = otherCount / total

  if (otherCount >= UNCATEGORIZED_MIN_COUNT && share >= UNCATEGORIZED_SHARE_THRESHOLD) {
    return { kind: "uncategorized", count: otherCount, share }
  }

  return null
}
