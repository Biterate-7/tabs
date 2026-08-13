"use client"

import { computeOverview } from "@/lib/workspace/stats"
import { useCountUp } from "@/hooks/use-count-up"
import type { Tab } from "@/lib/tabs/types"

function Stat({ label, value }: { label: string; value: number }) {
  const animated = useCountUp(value)
  return (
    <div className="flex items-baseline gap-2 py-3">
      <p className="text-h2 text-meta text-foreground">{animated}</p>
      <p className="text-label text-tertiary">{label}</p>
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
    <div className="flex flex-wrap divide-x divide-subtle border-b border-subtle">
      {stats.map((stat) => (
        <div key={stat.label} className="pr-6 pl-6 first:pl-0">
          <Stat label={stat.label} value={stat.value} />
        </div>
      ))}
    </div>
  )
}
