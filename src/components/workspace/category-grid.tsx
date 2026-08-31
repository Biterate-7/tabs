"use client"

import { useEffect, useRef, useState } from "react"
import { CategoryFolder } from "@/components/workspace/category-folder"
import { CategoryPage } from "@/components/workspace/category-page"
import { orderCategoriesByPresence } from "@/lib/workspace/hierarchy"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategoryGrid({
  tabs,
  onCategoryChange,
  onAddDependency,
  onInspect,
  onNotesChange,
  recentlyAddedIds,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
  onAddDependency?: (id: string) => void
  onInspect?: (id: string) => void
  onNotesChange?: (id: string, notes: string) => void
  recentlyAddedIds?: Set<string>
}) {
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null)
  const hasAnimated = useRef(false)
  useEffect(() => {
    hasAnimated.current = true
  }, [])

  const entries = orderCategoriesByPresence(tabs)
  const groupsById = Object.fromEntries(entries.map((e) => [e.id, e.tabs])) as Record<
    CategoryId,
    Tab[]
  >
  // Compact (empty/near-empty) categories render as a short chip, not a
  // full card — mixing the two in one CSS grid stretches every row to its
  // tallest sibling, leaving each chip stranded above a band of dead space.
  // Splitting them into their own flex-wrap strip lets chips hug their own
  // content height instead of inheriting a card's.
  const cardEntries = entries.filter((e) => e.presence !== "compact")
  const chipEntries = entries.filter((e) => e.presence === "compact")

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* A state-based mount flag would trigger a re-render that strips the
           animation mid-flight, cutting the stagger short for items whose
           delay hasn't elapsed yet. This ref read is a one-time snapshot for
           the current render pass, only ever mutated inside the mount effect
           below — it never changes mid-render. */}
        {/* eslint-disable-next-line react-hooks/refs */}
        {cardEntries.map((entry, index) => (
          <div
            key={entry.id}
            style={
              hasAnimated.current
                ? undefined
                : {
                    // The delay is folded into the shorthand's second <time>
                    // slot rather than set via a separate animationDelay
                    // entry — setting that longhand after a var()-timed
                    // shorthand corrupts the shorthand (every other longhand
                    // goes blank and the animation never plays); see the
                    // fuller explanation on tab-card.tsx's arrivalStyle.
                    animation: `category-card-in var(--duration-slow) var(--ease-standard) ${Math.min(index, 6) * 40}ms both`,
                  }
            }
          >
            <CategoryFolder
              categoryId={entry.id}
              tabs={entry.tabs}
              presence={entry.presence}
              onViewAll={() => setOpenCategory(entry.id)}
            />
          </div>
        ))}
      </div>

      {chipEntries.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {/* Same one-time mount snapshot as the card grid above. */}
          {/* eslint-disable-next-line react-hooks/refs */}
          {chipEntries.map((entry, index) => (
            <div
              key={entry.id}
              style={
                hasAnimated.current
                  ? undefined
                  : {
                      animation: `category-card-in var(--duration-slow) var(--ease-standard) ${Math.min(cardEntries.length + index, 6) * 40}ms both`,
                    }
              }
            >
              <CategoryFolder
                categoryId={entry.id}
                tabs={entry.tabs}
                presence={entry.presence}
                onViewAll={() => setOpenCategory(entry.id)}
              />
            </div>
          ))}
        </div>
      )}

      {openCategory && (
        <CategoryPage
          categoryId={openCategory}
          tabs={groupsById[openCategory]}
          onClose={() => setOpenCategory(null)}
          onCategoryChange={onCategoryChange}
          onAddDependency={onAddDependency}
          onInspect={onInspect}
          onNotesChange={onNotesChange}
          recentlyAddedIds={recentlyAddedIds}
        />
      )}
    </>
  )
}
