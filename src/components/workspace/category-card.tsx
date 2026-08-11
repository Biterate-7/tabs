import { ArrowRight } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { representativeDomains } from "@/lib/workspace/stats"

export function CategoryCard({
  categoryId,
  tabs,
  onViewAll,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  onViewAll: () => void
}) {
  const def = CATEGORIES[categoryId]
  const Icon = def.icon
  const isEmpty = tabs.length === 0
  const domains = representativeDomains(tabs, 3)

  return (
    <div
      className={
        "flex flex-col gap-3 rounded-lg border border-subtle bg-card p-4" +
        (isEmpty ? " opacity-50" : "")
      }
    >
      <div className="flex items-center gap-2">
        <Icon
          className="size-4 shrink-0"
          style={{ color: `var(${def.accentColor})` }}
        />
        <span className="text-sm font-medium text-foreground">{def.name}</span>
        <span className="ml-auto text-xs text-tertiary">
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      </div>

      {domains.length > 0 && (
        <ul className="space-y-1">
          {domains.map((domain) => (
            <li key={domain} className="truncate text-xs text-muted-foreground">
              {domain}
            </li>
          ))}
        </ul>
      )}

      {!isEmpty && (
        <button
          type="button"
          onClick={onViewAll}
          className="mt-auto flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          View all <ArrowRight className="size-3" />
        </button>
      )}
    </div>
  )
}
