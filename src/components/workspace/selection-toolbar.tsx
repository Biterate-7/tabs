import { Download, ExternalLink, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
}: {
  count: number
  onRecategorize: (id: CategoryId) => void
  onExportSelected: () => void
  onOpenSelected: () => void
  onRemoveSelected: () => void
  onClear: () => void
}) {
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
