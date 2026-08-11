import { computeOverview } from "@/lib/workspace/stats"
import type { Tab } from "@/lib/tabs/types"

export function WorkspaceOverview({ tabs }: { tabs: Tab[] }) {
  const { total, unique, categoriesInUse, duplicates } = computeOverview(tabs)
  const stats = [
    { label: "Total tabs", value: total },
    { label: "Unique", value: unique },
    { label: "Categories", value: categoriesInUse },
    { label: "Duplicates", value: duplicates },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 border-b border-subtle pb-6 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label}>
          <p className="text-2xl font-semibold tracking-tight text-foreground">
            {stat.value}
          </p>
          <p className="text-xs text-tertiary">{stat.label}</p>
        </div>
      ))}
    </div>
  )
}
