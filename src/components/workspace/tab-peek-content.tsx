import { ExternalLink, MoreHorizontal, StickyNote } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { TabNotesButton } from "@/components/workspace/tab-notes-button"
import { TabActionsMenu } from "@/components/workspace/tab-actions-menu"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import type { TabPeekContext } from "@/lib/tabs/peek"
import { openTab } from "@/lib/browser/open-tab"
import { cn } from "@/lib/utils"

/**
 * Tab Peek's presentational content — the same component whether it's
 * reached from a DOM tab row (TabPeekTrigger, via Base UI's PreviewCard) or
 * from the Graph canvas's hover tooltip escalating into the full card (see
 * GraphNodeTooltip). Pure and synchronous: `context` is either the fully
 * resolved snapshot from computeTabPeekContext or null (peek not open yet /
 * server render), never a loading state — the underlying reads are all
 * localStorage, so there's nothing worth showing a skeleton for.
 */
export function TabPeekContent({
  tab,
  context,
  onNotesChange,
  onOpenNotes,
  onCategoryChange,
  onInspect,
  onAddDependency,
  onRemoveFromCollection,
  otherCollections,
  onMoveToCollection,
}: {
  tab: Tab
  context: TabPeekContext | null
  /** The TabCard-everywhere path: renders the same inline notes popover (TabNotesButton) every other notes surface uses. Takes priority over onOpenNotes if both are somehow passed. */
  onNotesChange?: (id: string, notes: string) => void
  /** The Graph path: routes to GraphNodeNotesView, Graph's own full-page notes surface, instead of the inline popover. */
  onOpenNotes?: (id: string) => void
  /** Also gates whether the "More" action menu renders at all — omitted entirely in contexts (like the Graph canvas) that already have their own action surface. */
  onCategoryChange?: (id: string, category: CategoryId) => void
  onInspect?: (id: string) => void
  onAddDependency?: (id: string) => void
  onRemoveFromCollection?: (id: string) => void
  otherCollections?: { id: string; name: string }[]
  onMoveToCollection?: (id: string, collectionId: string) => void
}) {
  const title = tab.title?.trim() || tab.domain
  const categoryId = (tab.category as CategoryId | undefined) ?? "other"
  const category = CATEGORIES[categoryId] ?? CATEGORIES.other

  return (
    <div className="w-80 max-w-[calc(100vw-2rem)]">
      <div className="flex items-center gap-2.5 p-3 pb-2.5">
        <TabFavicon domain={tab.domain} size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-foreground">{title}</p>
          <p className="truncate text-body-sm text-tertiary">{tab.domain}</p>
        </div>
      </div>

      {/* No real page-snapshot mechanism exists in TabDump — this is the
          "beautiful fallback" the spec calls for, not a degraded state: a
          category-tinted panel built entirely from data the tab already
          carries, so it never depends on a network fetch succeeding. Purely
          a visual accent (the category's identity color, echoed as a tinted
          field behind an enlarged favicon) — title and domain already read
          clearly in the header above, so this panel doesn't repeat them. */}
      <div
        className="mx-3 flex h-16 items-center justify-center rounded-lg"
        style={{ backgroundColor: `color-mix(in srgb, var(${category.accentColor}) 10%, var(--surface))` }}
      >
        <TabFavicon domain={tab.domain} size={32} />
      </div>

      <div className="space-y-1 px-3 pt-2.5 pb-2 text-meta text-tertiary">
        <p className="truncate">
          {context?.workspaceName ?? "No workspace"} <span aria-hidden>·</span> {context?.categoryName ?? category.name}
        </p>
        <p className="truncate">{context?.collectionName ? `Collection: ${context.collectionName}` : "No collection"}</p>
        <p className="truncate">
          {context?.hasNotes ? "Has notes" : "No notes yet"} <span aria-hidden>·</span>{" "}
          {context && context.connectionCount > 0
            ? `${context.connectionCount} connection${context.connectionCount === 1 ? "" : "s"}`
            : "No connections"}
        </p>
      </div>

      <div className="flex items-center gap-1 border-t border-subtle px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={() => openTab(tab.url)}>
          <ExternalLink /> Open
        </Button>
        {onNotesChange ? (
          <TabNotesButton tabId={tab.id} domain={tab.domain} notes={tab.notes} onNotesChange={onNotesChange} />
        ) : (
          onOpenNotes && (
            <IconButton
              aria-label={context?.hasNotes ? `View note for ${tab.domain}` : `No notes for ${tab.domain}`}
              tooltip={context?.hasNotes ? "View note" : "No notes yet"}
              className={cn("size-8", context?.hasNotes && "text-accent-text")}
              onClick={() => onOpenNotes(tab.id)}
            >
              <StickyNote fill={context?.hasNotes ? "currentColor" : "none"} fillOpacity={context?.hasNotes ? 0.15 : 1} />
            </IconButton>
          )
        )}
        <div className="ml-auto">
          {onCategoryChange && (
            <TabActionsMenu
              tab={tab}
              onCategoryChange={onCategoryChange}
              onInspect={onInspect}
              onAddDependency={onAddDependency}
              onRemoveFromCollection={onRemoveFromCollection}
              otherCollections={otherCollections}
              onMoveToCollection={onMoveToCollection}
              trigger={
                <IconButton aria-label={`More actions for ${tab.domain}`} className="size-8">
                  <MoreHorizontal />
                </IconButton>
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
