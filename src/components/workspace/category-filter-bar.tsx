import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { categoryCounts } from "@/lib/workspace/search"

export function Pill({
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
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2 py-1 text-xs font-medium transition-colors duration-(--duration-fast) ease-(--ease-standard)",
        active
          ? "border-primary/30 bg-primary/15 text-accent-text"
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
  // Categories with nothing in them yet aren't worth a filter pill — filtering
  // down to an empty category can never show anything, and CategoryGrid
  // already surfaces "this category exists but is empty" via its own compact
  // chip row. Showing both here and there would just repeat the same
  // name-and-count twice on one screen. A category the active filter is
  // already pointed at stays visible even at zero (e.g. the last tab in it
  // just got recategorized away) so the active state never disappears out
  // from under the user.
  const visibleCategories = CATEGORY_ORDER.filter((id) => counts[id] > 0 || value === id)

  return (
    <div className="flex flex-wrap gap-2">
      <Pill active={value === "all"} onClick={() => onChange("all")}>
        All ({tabs.length})
      </Pill>
      {visibleCategories.map((id) => (
        <Pill key={id} active={value === id} onClick={() => onChange(id)}>
          {CATEGORIES[id].name} ({counts[id]})
        </Pill>
      ))}
    </div>
  )
}
