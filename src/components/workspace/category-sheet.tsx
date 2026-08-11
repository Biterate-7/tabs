import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabCard } from "@/components/workspace/tab-card"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategorySheet({
  categoryId,
  tabs,
  open,
  onOpenChange,
  onCategoryChange,
}: {
  categoryId: CategoryId | null
  tabs: Tab[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const def = categoryId ? CATEGORIES[categoryId] : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {def?.name} · {tabs.length} tab{tabs.length === 1 ? "" : "s"}
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-6rem)] px-4">
          <div className="space-y-2 pb-6">
            {tabs.map((tab) => (
              <TabCard key={tab.id} tab={tab} onCategoryChange={onCategoryChange} />
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
