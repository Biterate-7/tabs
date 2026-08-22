"use client"

import { ExternalLink } from "lucide-react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { AskSource } from "@/lib/ai/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

export function SourceCard({ source }: { source: AskSource }) {
  const category = (source.category as CategoryId | undefined) ?? "other"

  return (
    <button
      type="button"
      onClick={() => openTab(source.url)}
      className="flex w-full items-center gap-3 rounded-lg border border-subtle bg-card px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border"
    >
      <TabFavicon domain={source.domain} size={24} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-sm font-medium text-foreground">{source.title}</p>
        <p className="truncate text-meta text-tertiary">
          {source.domain} · {CATEGORIES[category]?.name ?? "Other"}
        </p>
      </div>
      <ExternalLink className="size-3.5 shrink-0 text-tertiary" aria-hidden />
    </button>
  )
}
