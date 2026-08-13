import { Bookmark } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
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
      <SheetContent className="data-[side=right]:w-full sm:data-[side=right]:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-h1">
            {def?.name} <span className="text-tertiary">· {tabs.length} tab{tabs.length === 1 ? "" : "s"}</span>
          </SheetTitle>
        </SheetHeader>
        {tabs.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title={`No tabs in ${def?.name ?? "this category"} anymore.`}
            description="They were recategorized or removed elsewhere in this session."
          />
        ) : (
          <ScrollArea className="h-[calc(100vh-6rem)] px-4">
            <div className="rounded-lg border border-subtle bg-card px-2 pb-6">
              {tabs.map((tab) => (
                <TabCard key={tab.id} tab={tab} onCategoryChange={onCategoryChange} />
              ))}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
