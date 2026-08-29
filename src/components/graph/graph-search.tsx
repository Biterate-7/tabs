"use client"

import { SearchBar } from "@/components/workspace/search-bar"
import type { GraphNode } from "@/lib/graph/types"

export function GraphSearch({
  query,
  onQueryChange,
  matches,
  onSelectResult,
}: {
  query: string
  onQueryChange: (value: string) => void
  matches: GraphNode[]
  onSelectResult: (id: string) => void
}) {
  const hasQuery = query.trim().length > 0

  return (
    <div>
      <SearchBar
        value={query}
        onChange={onQueryChange}
        onEnter={() => {
          if (matches[0]) onSelectResult(matches[0].id)
        }}
        className="w-full"
      />
      {hasQuery && (
        <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-1 py-1 text-body-sm text-tertiary">No tabs match &ldquo;{query}&rdquo;.</p>
          ) : (
            matches.slice(0, 25).map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelectResult(node.id)}
                className="block w-full truncate rounded-md px-1.5 py-1 text-left text-body-sm text-foreground transition-colors duration-(--duration-fast) hover:bg-accent"
              >
                {node.tab.title?.trim() || node.tab.domain}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
