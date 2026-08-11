import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { categoryCounts } from "@/lib/workspace/search"

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary/30 bg-primary/15 text-primary"
          : "border-subtle bg-card text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

export function CategoryFilterBar({
  tabs,
  value,
  onChange,
}: {
  tabs: Tab[]
  value: CategoryId | "all"
  onChange: (value: CategoryId | "all") => void
}) {
  const counts = categoryCounts(tabs)

  return (
    <div className="flex flex-wrap gap-2">
      <Pill active={value === "all"} onClick={() => onChange("all")}>
        All ({tabs.length})
      </Pill>
      {CATEGORY_ORDER.map((id) => (
        <Pill key={id} active={value === id} onClick={() => onChange(id)}>
          {CATEGORIES[id].name} ({counts[id]})
        </Pill>
      ))}
    </div>
  )
}
