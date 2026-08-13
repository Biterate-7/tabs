import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import type { CategoryPresence } from "@/lib/workspace/hierarchy"
import { representativeDomains } from "@/lib/workspace/stats"

export function CategoryCard({
  categoryId,
  tabs,
  presence,
  onViewAll,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  presence: CategoryPresence
  onViewAll: () => void
}) {
  const def = CATEGORIES[categoryId]
  const Icon = def.icon
  const isEmpty = tabs.length === 0
  const domainLimit = presence === "large" ? 5 : presence === "standard" ? 3 : 0
  const domains = representativeDomains(tabs, domainLimit)

  if (presence === "compact") {
    return (
      <button
        type="button"
        onClick={isEmpty ? undefined : onViewAll}
        disabled={isEmpty}
        aria-label={
          isEmpty
            ? `${def.name}: no tabs`
            : `View all ${tabs.length} ${def.name} tab${tabs.length === 1 ? "" : "s"}`
        }
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) sm:min-h-0",
          isEmpty
            ? "cursor-default opacity-45"
            : "bg-card hover:border-border"
        )}
      >
        <Icon
          className="size-3.5 shrink-0"
          style={{ color: `var(${def.accentColor})` }}
        />
        <span className="text-body-sm text-foreground">{def.name}</span>
        <span className="ml-auto text-meta text-tertiary">{tabs.length}</span>
      </button>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-subtle bg-card p-4",
        presence === "large" && "sm:col-span-2 lg:col-span-1 lg:row-span-1"
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className="size-4 shrink-0"
          style={{ color: `var(${def.accentColor})` }}
        />
        <span className="text-body font-medium text-foreground">{def.name}</span>
        <span className="ml-auto text-meta text-tertiary">
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      </div>

      {domains.length > 0 && (
        <ul className="space-y-1">
          {domains.map((domain) => (
            <li key={domain} className="truncate text-body-sm text-muted-foreground">
              {domain}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onViewAll}
        aria-label={`View all ${tabs.length} ${def.name} tab${tabs.length === 1 ? "" : "s"}`}
        className="mt-auto flex min-h-6 w-fit items-center gap-1 py-1 text-label text-accent-text hover:underline"
      >
        View all <ArrowRight className="size-3" />
      </button>
    </div>
  )
}
