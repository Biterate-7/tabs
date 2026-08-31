"use client"

import { useState, type ReactNode } from "react"
import { PreviewCard } from "@base-ui/react/preview-card"
import { TabPeekContent } from "@/components/workspace/tab-peek-content"
import { computeTabPeekContext, type TabPeekContext } from "@/lib/tabs/peek"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { cn } from "@/lib/utils"

// Spec calls for "~300-500ms" before the peek opens, and a close delay
// generous enough that moving the cursor diagonally from the trigger toward
// the popup never races the close (Base UI's own hover-intent tracking
// handles the actual bridging; this delay is just the grace window once the
// pointer has genuinely left both).
const OPEN_DELAY_MS = 400
const CLOSE_DELAY_MS = 200

/**
 * Wraps a tab's title/domain text (or any other tab-identity element) with
 * TabDump's shared "Tab Peek" hover/focus preview — the one implementation
 * every tab-rendering surface reuses, per the design brief. Built on Base
 * UI's PreviewCard (same portal/positioner/popup shape as Tooltip and
 * DropdownMenu elsewhere in this codebase), which already provides the hard
 * parts for free: hover-intent delay, a safe bridge into the popup, focus
 * support for keyboard users, outside-press/Escape dismissal, and
 * viewport-aware flipping — none of that is reimplemented here.
 *
 * Peek data (workspace/collection/notes/connections) is computed lazily, only
 * once the popup actually opens, via computeTabPeekContext — never on mount,
 * never for tabs that are never hovered.
 */
export function TabPeekTrigger({
  tab,
  children,
  className,
  onNotesChange,
  onCategoryChange,
  onInspect,
  onAddDependency,
  onRemoveFromCollection,
  otherCollections,
  onMoveToCollection,
  onToggleFavorite,
  onOpenTab,
}: {
  tab: Tab
  children: ReactNode
  className?: string
  onNotesChange?: (id: string, notes: string) => void
  onCategoryChange: (id: string, category: CategoryId) => void
  onInspect?: (id: string) => void
  onAddDependency?: (id: string) => void
  onRemoveFromCollection?: (id: string) => void
  otherCollections?: { id: string; name: string }[]
  onMoveToCollection?: (id: string, collectionId: string) => void
  onToggleFavorite?: (id: string) => void
  onOpenTab?: (id: string) => void
}) {
  const [context, setContext] = useState<TabPeekContext | null>(null)

  return (
    <PreviewCard.Root
      onOpenChange={(open) => {
        if (open) setContext(computeTabPeekContext(tab))
      }}
    >
      <PreviewCard.Trigger
        delay={OPEN_DELAY_MS}
        closeDelay={CLOSE_DELAY_MS}
        render={
          // A real <button> (not a styled div) so it's natively focusable —
          // required for the keyboard-triggered peek — without guessing at
          // what tabIndex/role Base UI's default <a>-based trigger assumes.
          // It performs no action of its own on click/Enter; opening the
          // preview is the only thing this element does.
          <button type="button" className={cn("cursor-default border-0 bg-transparent p-0 text-inherit", className)}>
            {children}
          </button>
        }
      />
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          side="bottom"
          align="start"
          sideOffset={10}
          collisionPadding={16}
          className="z-[60] outline-none"
        >
          <PreviewCard.Popup
            className={cn(
              "rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10",
              "origin-(--transform-origin) transition-[transform,opacity] duration-(--duration-base) ease-(--ease-standard)",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
            )}
          >
            <TabPeekContent
              tab={tab}
              context={context}
              onNotesChange={onNotesChange}
              onCategoryChange={onCategoryChange}
              onInspect={onInspect}
              onAddDependency={onAddDependency}
              onRemoveFromCollection={onRemoveFromCollection}
              otherCollections={otherCollections}
              onMoveToCollection={onMoveToCollection}
              onToggleFavorite={onToggleFavorite}
              onOpenTab={onOpenTab}
            />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}
