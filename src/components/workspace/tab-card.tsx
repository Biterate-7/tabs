"use client"

import { ExternalLink, MoreHorizontal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

export function TabCard({
  tab,
  onCategoryChange,
  selectable = false,
  selected = false,
  onToggleSelected,
}: {
  tab: Tab
  onCategoryChange: (id: string, category: CategoryId) => void
  selectable?: boolean
  selected?: boolean
  onToggleSelected?: () => void
}) {
  const category = (tab.category as CategoryId | undefined) ?? "other"
  const primaryLine = tab.title?.trim() || tab.domain

  return (
    <div className="group flex items-center gap-3 border-b border-subtle px-1 py-2.5 last:border-b-0">
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
