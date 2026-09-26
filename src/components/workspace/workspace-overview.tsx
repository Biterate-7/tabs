"use client"

import { computeOverview } from "@/lib/workspace/stats"
import { useCountUp } from "@/hooks/use-count-up"
import type { Tab } from "@/lib/tabs/types"

function Stat({ label, value }: { label: string; value: number }) {
  const animated = useCountUp(value)
  return (
    <div className="flex items-baseline gap-1">
      <p className="text-body text-foreground tabular-nums">{animated}</p>
      <p className="text-body text-muted-foreground">{label}</p>
    </div>
  )
}

export function WorkspaceOverview({ tabs }: { tabs: Tab[] }) {
  const { total, unique, categoriesInUse, duplicates } = computeOverview(tabs)
  const stats = [
    { label: "total", value: total },
    { label: "unique", value: unique },
    { label: "categories", value: categoriesInUse },
    { label: "duplicates", value: duplicates },
  ]

  return (
    // One quiet line of facts rather than a row of counters.
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {stats.map((stat, i) => (
        <div key={stat.label} className="flex items-baseline gap-2">
          {i > 0 && (
            <span aria-hidden className="text-tertiary">
              ·
            </span>
          )}
          <Stat label={stat.label} value={stat.value} />
        </div>
      ))}
    </div>
  )
}
