"use client"

import { ExternalLink, Search } from "lucide-react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import type { MatchReason, SearchResult } from "@/lib/ai/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

const MATCH_REASON_LABELS: Record<MatchReason, string> = {
  title: "Title match",
  url: "URL/domain match",
  workspace: "Workspace match",
  group: "Group match",
  semantic: "Semantic match",
  keyword: "Keyword match",
}

type WorkspaceGroup = { workspaceId: string; workspaceName: string; results: SearchResult[] }

/** Preserves first-seen order (already relevance-ranked) rather than sorting groups alphabetically. */
function groupByWorkspace(results: SearchResult[]): WorkspaceGroup[] {
  const order: string[] = []
  const byId = new Map<string, WorkspaceGroup>()
  for (const result of results) {
    if (!byId.has(result.workspaceId)) {
      byId.set(result.workspaceId, { workspaceId: result.workspaceId, workspaceName: result.workspaceName, results: [] })
      order.push(result.workspaceId)
    }
    byId.get(result.workspaceId)!.results.push(result)
  }
  return order.map((id) => byId.get(id)!)
}

/**
 * Renders one global-search result set inside the Ask Tabs conversation,
 * grouped by workspace. Long titles/URLs wrap (min-w-0 + break-words)
 * rather than clipping or forcing horizontal scroll — the panel's own
 * overflow was a real bug fixed earlier, so nothing here assumes a fixed
 * width. The full URL lives in the row's title attribute (native tooltip)
 * rather than as visible text, keeping each row to one clear line.
 */
export function SearchResultsCard({ results }: { results: SearchResult[] }) {
  if (results.length === 0) return null

  const groups = groupByWorkspace(results)
  const workspaceCount = groups.length

  return (
    <div className="min-w-0 space-y-3 rounded-lg border border-subtle p-3">
      <div className="flex items-center gap-1.5 text-label text-tertiary">
        <Search className="size-3.5" aria-hidden />
        {results.length} result{results.length === 1 ? "" : "s"}
        {workspaceCount > 1 ? ` across ${workspaceCount} workspaces` : ""}
      </div>

      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.workspaceId} className="min-w-0 space-y-1.5">
            <p className="break-words text-body-sm font-medium text-foreground">{group.workspaceName}</p>
            <div className="space-y-1.5">
              {group.results.map((result) => (
                <button
                  key={result.tabId}
                  type="button"
                  onClick={() => openTab(result.url)}
                  title={result.url}
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-subtle bg-card px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border"
                >
                  <TabFavicon domain={result.domain} size={24} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-body-sm font-medium text-foreground">{result.title}</p>
                    <p className="break-words text-meta text-tertiary">
                      {result.domain} · {MATCH_REASON_LABELS[result.matchReason]}
                      {result.groupName ? ` · ${result.groupName}` : ""}
                    </p>
                  </div>
                  <ExternalLink className="size-3.5 shrink-0 text-tertiary" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
