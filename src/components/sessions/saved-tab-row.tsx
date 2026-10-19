"use client"

import type { ReactNode } from "react"
import { Pin } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { hostOf, tabLabel } from "@/lib/sessions/model"
import { cn } from "@/lib/utils"
import type { SavedTab } from "@/lib/sessions/types"

/**
 * One saved tab in a list: Chrome's icon (or the site's), the title it was
 * saved with, and its site — never the raw address as the label. Nothing is
 * fetched from the page itself.
 */
export function SavedTabRow({
  tab,
  checked,
  onCheckedChange,
  actions,
  note,
}: {
  tab: SavedTab
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Controls at the end of the row (the editor's move buttons). */
  actions?: ReactNode
  /** Shown in place of the site: why a chosen tab won't open ("Duplicate"). */
  note?: string
}) {
  const host = hostOf(tab.url)
  const label = tabLabel(tab)
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xs px-1 py-1 hover:bg-surface-hover">
      {/* Not a <label>: Base UI would then name the checkbox after the whole row. The row still toggles it. */}
      <Checkbox checked={checked} onCheckedChange={(on) => onCheckedChange(on === true)} aria-label={label} />
      <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={tab.url} onClick={() => onCheckedChange(!checked)}>
        <TabFavicon domain={host} icon={tab.favicon} size={16} />
        <span className={cn("min-w-0 flex-1 truncate text-body", note ? "text-tertiary line-through" : "text-foreground")}>{label}</span>
        {tab.pinned && <Pin aria-label="Pinned" className="size-3 shrink-0 text-tertiary" />}
        {note ? (
          <span className="shrink-0 text-meta text-tertiary">{note}</span>
        ) : (
          <span className="max-w-[40%] shrink-0 truncate text-meta text-tertiary max-sm:hidden">{host}</span>
        )}
      </div>
      {actions}
    </div>
  )
}
