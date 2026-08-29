import { Download, ExternalLink, Layers, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"

export function SelectionToolbar({
  count,
  onRecategorize,
  onExportSelected,
  onOpenSelected,
  onRemoveSelected,
  onClear,
  collections,
  onAddToCollection,
  onGatherNew,
  addToCollectionTarget,
}: {
  count: number
  onRecategorize: (id: CategoryId) => void
  onExportSelected: () => void
  onOpenSelected: () => void
  onRemoveSelected: () => void
  onClear: () => void
  /** Existing collections in the current workspace, for the "Gather" dropdown's "Add to <name>" entries. */
  collections?: { id: string; name: string }[]
  onAddToCollection?: (collectionId: string) => void
  /** Opens GatherDialog seeded with the current selection — "New collection…". */
  onGatherNew?: () => void
  /** Set while "Add tabs" was invoked from a specific collection's header menu — swaps the whole toolbar into a focused "confirm/cancel" mode instead of the general selection actions. */
  addToCollectionTarget?: { name: string; onConfirm: () => void }
}) {
  if (addToCollectionTarget) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-2 border-t border-primary/30 bg-popover px-3 py-3 sm:sticky sm:top-0 sm:rounded-lg sm:border sm:border-primary/30 sm:bg-primary/[0.08] sm:py-2">
        <span className="shrink-0 text-body font-medium text-foreground">{count} selected</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="default" size="sm" onClick={addToCollectionTarget.onConfirm} disabled={count === 0}>
            <Layers /> Add to {addToCollectionTarget.name}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X /> Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-2 border-t border-primary/30 bg-popover px-3 py-3 sm:sticky sm:top-0 sm:rounded-lg sm:border sm:border-primary/30 sm:bg-primary/[0.08] sm:py-2">
      <span className="shrink-0 text-body font-medium text-foreground">
        {count} selected
      </span>

      <div className="ml-auto flex items-center gap-1.5 overflow-x-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm">Recategorize</Button>}
          />
          <DropdownMenuContent align="end">
            {CATEGORY_ORDER.map((id) => (
              <DropdownMenuItem key={id} onClick={() => onRecategorize(id)}>
                {CATEGORIES[id].name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {onGatherNew && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm">Gather</Button>} />
            <DropdownMenuContent align="end">
              {collections && collections.length > 0 && (
                <>
                  {collections.map((c) => (
                    <DropdownMenuItem key={c.id} onClick={() => onAddToCollection?.(c.id)}>
                      Add to {c.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={onGatherNew}>
                <Layers /> New collection…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button variant="ghost" size="sm" onClick={onExportSelected}>
          <Download /> Export
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSelected}>
          <ExternalLink /> Open
        </Button>
        <Button variant="destructive" size="sm" onClick={onRemoveSelected}>
          <Trash2 /> Remove
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X /> Clear selection
        </Button>
      </div>
    </div>
  )
}
