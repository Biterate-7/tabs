"use client"

import { useEffect, useRef, useState } from "react"
import { CategoryCard } from "@/components/workspace/category-card"
import { CategorySheet } from "@/components/workspace/category-sheet"
import { orderCategoriesByPresence } from "@/lib/workspace/hierarchy"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategoryGrid({
  tabs,
  onCategoryChange,
  workspaceId,
  onSheetOpenChange,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
  workspaceId: string
  /** Fires whenever the category detail sheet opens/closes — lets the caller know a CollectionAiActions button just became reachable, e.g. to lazily kick off AI indexing only once it might actually be used. */
  onSheetOpenChange?: (open: boolean) => void
}) {
  const [openCategory, setOpenCategoryState] = useState<CategoryId | null>(null)
  function setOpenCategory(id: CategoryId | null) {
    setOpenCategoryState(id)
    onSheetOpenChange?.(id !== null)
  }
  const hasAnimated = useRef(false)
  useEffect(() => {
    hasAnimated.current = true
  }, [])

  // "Latest ref" idiom (see use-title-resolution.ts/use-ask-tabdump.ts) —
  // both read fresh in the unmount-only cleanup below, which otherwise
  // closes over stale values from whichever render first mounted this
  // effect. WorkspaceView swaps CategoryGrid out for FilteredTabList (and
  // unmounts it, sheet and all) the moment the user starts searching or
  // filtering — with no cleanup, a sheet left open at that instant would
  // leave the parent's onSheetOpenChange flag stuck `true` forever, since
  // nothing else ever tells it the sheet closed.
  const openCategoryRef = useRef(openCategory)
  // eslint-disable-next-line react-hooks/refs
  openCategoryRef.current = openCategory
  const onSheetOpenChangeRef = useRef(onSheetOpenChange)
  // eslint-disable-next-line react-hooks/refs
  onSheetOpenChangeRef.current = onSheetOpenChange

  useEffect(() => {
    return () => {
      if (openCategoryRef.current !== null) onSheetOpenChangeRef.current?.(false)
    }
  }, [])

  const entries = orderCategoriesByPresence(tabs)
  const groupsById = Object.fromEntries(entries.map((e) => [e.id, e.tabs])) as Record<
    CategoryId,
    Tab[]
  >

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* A state-based mount flag would trigger a re-render that strips the
           animation mid-flight, cutting the stagger short for items whose
           delay hasn't elapsed yet. This ref read is a one-time snapshot for
           the current render pass, only ever mutated inside the mount effect
           below — it never changes mid-render. */}
        {/* eslint-disable-next-line react-hooks/refs */}
        {entries.map((entry, index) => (
          <div
            key={entry.id}
            style={
              hasAnimated.current
                ? undefined
                : {
                    animation:
                      "category-card-in var(--duration-slow) var(--ease-standard) both",
                    animationDelay: `${Math.min(index, 6) * 40}ms`,
                  }
            }
          >
            <CategoryCard
              categoryId={entry.id}
              tabs={entry.tabs}
              presence={entry.presence}
              onViewAll={() => setOpenCategory(entry.id)}
            />
          </div>
        ))}
      </div>

      <CategorySheet
        categoryId={openCategory}
        tabs={openCategory ? groupsById[openCategory] : []}
        open={openCategory !== null}
        onOpenChange={(open) => !open && setOpenCategory(null)}
        onCategoryChange={onCategoryChange}
        workspaceId={workspaceId}
      />
    </>
  )
}
