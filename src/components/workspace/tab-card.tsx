"use client"

import type { CSSProperties } from "react"
import { ExternalLink, GitBranchPlus, MoreHorizontal, PanelRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { TabDependencyIndicator, type DependencyIndicatorData } from "@/components/workspace/tab-dependency-indicator"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { openTab } from "@/lib/browser/open-tab"
import { cn } from "@/lib/utils"

/**
 * Deterministic per-tab jitter so a batch of "recently added" cards doesn't
 * all animate in identically — see the tab-card-in keyframe in globals.css.
 *
 * The delay is folded into the `animation` shorthand's second <time> slot
 * (duration, then delay) rather than set as a separate `animationDelay`
 * entry in this style object: setting a longhand animation-* property after
 * a shorthand that contains var() forces the browser to decompose that
 * shorthand into its longhands, which it can't do for a var()-bearing value
 * — the result is every other longhand (name, duration, fill-mode) silently
 * going blank and the animation never playing at all. One shorthand string
 * is the only way to set a var()-timed animation plus a delay together.
 */
function arrivalStyle(id: string): CSSProperties {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  hash = Math.abs(hash)
  const delay = hash % 220
  const duration = 260 + (hash % 3) * 30
  const xJitter = ((hash % 7) - 3) * 1.5
  return {
    "--tab-in-x": `${xJitter}px`,
    "--tab-in-y": "10px",
    animation: `tab-card-in ${duration}ms var(--ease-standard) ${delay}ms both`,
  } as CSSProperties
}

export function TabCard({
  tab,
  onCategoryChange,
  selectable = false,
  selected = false,
  onToggleSelected,
  onAddDependency,
  onInspect,
  dependencyIndicator,
  onSelectDependencyTab,
  onOpenDependencyTab,
  isRecentlyAdded = false,
}: {
  tab: Tab
  onCategoryChange: (id: string, category: CategoryId) => void
  selectable?: boolean
  selected?: boolean
  onToggleSelected?: () => void
  /** Omitted entirely in contexts that don't wire up the dependency dialog — the menu item simply doesn't render. */
  onAddDependency?: (id: string) => void
  /** Omitted entirely in contexts that don't wire up the tab inspector sheet — the menu item simply doesn't render. */
  onInspect?: (id: string) => void
  /** This tab's dependency/used-by relationships, pre-resolved to displayable labels. Omitted entirely (not just empty) in contexts that don't compute it — see filtered-tab-list.tsx. */
  dependencyIndicator?: DependencyIndicatorData
  onSelectDependencyTab?: (id: string) => void
  onOpenDependencyTab?: (id: string) => void
  /** True for a short window right after this tab was dumped/imported — a transient, non-persisted highlight (see app-shell.tsx's recentlyAddedIds). */
  isRecentlyAdded?: boolean
}) {
  const category = (tab.category as CategoryId | undefined) ?? "other"
  const primaryLine = tab.title?.trim() || tab.domain

  return (
    <div
      className={cn(
        "group flex items-center gap-3 border-b border-subtle px-1 py-2.5 transition-colors duration-(--duration-fast) ease-(--ease-standard) last:border-b-0",
        "focus-within:rounded-md focus-within:ring-2 focus-within:ring-ring/50",
        selected && "rounded-md bg-primary/5",
        isRecentlyAdded && "rounded-md bg-accent-text/[0.06]",
        tab.isDuplicate && "opacity-70"
      )}
      style={isRecentlyAdded ? arrivalStyle(tab.id) : undefined}
    >
      {selectable && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelected?.()}
          aria-label={`Select ${tab.domain}`}
        />
      )}

      <TabFavicon domain={tab.domain} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-foreground">{primaryLine}</p>
        <p className="truncate text-body-sm text-tertiary">{tab.domain}</p>
        {dependencyIndicator && (
          <TabDependencyIndicator
            data={dependencyIndicator}
            onSelect={onSelectDependencyTab}
            onOpen={onOpenDependencyTab}
          />
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          nativeButton={false}
          render={
            <Badge
              variant="outline"
              aria-label={`Category: ${CATEGORIES[category].name}. Change category for ${tab.domain}`}
              className="hidden shrink-0 cursor-pointer sm:inline-flex"
            >
              {CATEGORIES[category].name}
            </Badge>
          }
        />
        <DropdownMenuContent align="end">
          {CATEGORY_ORDER.map((id) => (
            <DropdownMenuItem
              key={id}
              onClick={() => onCategoryChange(tab.id, id)}
            >
              {CATEGORIES[id].name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:duration-(--duration-fast) sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:has-data-open:opacity-100">
        <IconButton
          aria-label={`Open ${tab.domain}`}
          onClick={() => openTab(tab.url)}
          className="size-11 sm:size-8"
        >
          <ExternalLink />
        </IconButton>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                aria-label={`More actions for ${tab.domain}`}
                className="size-11 sm:size-8"
              >
                <MoreHorizontal />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openTab(tab.url)}>Open</DropdownMenuItem>
            {onInspect && (
              <DropdownMenuItem onClick={() => onInspect(tab.id)}>
                <PanelRight /> Inspect…
              </DropdownMenuItem>
            )}
            {onAddDependency && (
              <DropdownMenuItem onClick={() => onAddDependency(tab.id)}>
                <GitBranchPlus /> Add dependency…
              </DropdownMenuItem>
            )}
            {(onInspect || onAddDependency) && <DropdownMenuSeparator />}
            {CATEGORY_ORDER.map((id) => (
              <DropdownMenuItem
                key={id}
                onClick={() => onCategoryChange(tab.id, id)}
              >
                Move to {CATEGORIES[id].name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
