"use client"

import { useState } from "react"
import { Sparkles, Search, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SourceCard } from "@/components/ai/source-card"
import { analyzeCollection, findCollectionGaps } from "@/lib/ai/collection-analysis"
import type { CollectionOverview, CollectionGaps } from "@/lib/ai/types"
import type { Tab } from "@/lib/tabs/types"

type Result = { kind: "overview"; data: CollectionOverview } | { kind: "gaps"; data: CollectionGaps }

export function CollectionAiActions({
  workspaceId,
  categoryName,
  tabs,
}: {
  workspaceId: string
  categoryName: string
  tabs: Tab[]
}) {
  const [loading, setLoading] = useState<"overview" | "gaps" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  async function handleOverview() {
    setLoading("overview")
    setError(null)
    const res = await analyzeCollection(workspaceId, categoryName, tabs)
    setLoading(null)
    if (res.ok) setResult({ kind: "overview", data: res.data })
    else setError(res.error)
  }

  async function handleGaps() {
    setLoading("gaps")
    setError(null)
    const res = await findCollectionGaps(workspaceId, categoryName, tabs)
    setLoading(null)
    if (res.ok) setResult({ kind: "gaps", data: res.data })
    else setError(res.error)
  }

  return (
    <div className="space-y-3 border-b border-subtle px-4 pb-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={handleOverview} disabled={loading !== null}>
          {loading === "overview" ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Understand this collection
        </Button>
        <Button variant="secondary" size="sm" onClick={handleGaps} disabled={loading !== null}>
          {loading === "gaps" ? <Loader2 className="animate-spin" /> : <Search />}
          Find gaps
        </Button>
      </div>

      {error && <p className="text-body-sm text-destructive">{error}</p>}

      {result?.kind === "overview" && (
        <div className="space-y-3 rounded-lg border border-subtle bg-card p-3">
          <p className="text-body-sm text-foreground">{result.data.overview}</p>

          {result.data.themes.length > 0 && (
            <div>
              <p className="text-label text-tertiary">Main themes</p>
              <ul className="mt-1 list-inside list-disc text-body-sm text-foreground">
                {result.data.themes.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}

          {result.data.keyInsights.length > 0 && (
            <div>
              <p className="text-label text-tertiary">Key insights</p>
              <ul className="mt-1 list-inside list-disc text-body-sm text-foreground">
                {result.data.keyInsights.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}

          {result.data.importantResources.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-label text-tertiary">Important resources</p>
              {result.data.importantResources.map((source) => (
                <SourceCard key={source.tabId} source={source} />
              ))}
            </div>
          )}
        </div>
      )}

      {result?.kind === "gaps" && (
        <div className="space-y-3 rounded-lg border border-subtle bg-card p-3">
          <p className="text-meta text-tertiary">
            Based only on what you&rsquo;ve saved here — not an objective judgment of the topic.
          </p>
          {result.data.covered.length > 0 && (
            <div>
              <p className="text-label text-tertiary">Your research covers</p>
              <ul className="mt-1 space-y-1 text-body-sm text-foreground">
                {result.data.covered.map((c) => (
                  <li key={c}>✓ {c}</li>
                ))}
              </ul>
            </div>
          )}
          {result.data.gaps.length > 0 && (
            <div>
              <p className="text-label text-tertiary">Possible gaps</p>
              <ul className="mt-1 space-y-1 text-body-sm text-foreground">
                {result.data.gaps.map((g) => (
                  <li key={g}>⚠ {g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
