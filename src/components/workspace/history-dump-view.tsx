"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, ScanSearch, Loader2, PlugZap } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
import { SearchBar } from "@/components/workspace/search-bar"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { useHistoryDump } from "@/hooks/use-history-dump"
import { HISTORY_TIME_RANGES, DEFAULT_HISTORY_TIME_RANGE } from "@/lib/history-dump/types"
import type { HistoryCandidate, HistoryTimeRangeId } from "@/lib/history-dump/types"
import type { CustomHistoryRange } from "@/lib/history-dump/time-range"
import type { BrowserImportEntry } from "@/lib/tabs/browser-import"
import type { Tab } from "@/lib/tabs/types"
import { cn } from "@/lib/utils"

const INITIAL_VISIBLE_LIMIT = 60
type ReviewFilter = "all" | "suggested" | "already"

function toDateInputValue(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function parseDateInputValue(value: string, endOfDay: boolean): number | null {
  if (!value) return null
  const [y, m, d] = value.split("-").map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime()
}

function matchesSearch(candidate: HistoryCandidate, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    (candidate.title?.toLowerCase().includes(q) ?? false) ||
    candidate.domain.toLowerCase().includes(q) ||
    candidate.url.toLowerCase().includes(q)
  )
}

function tabsLabel(n: number): string {
  return `${n} tab${n === 1 ? "" : "s"}`
}

/** One reviewable (or already-captured) row. Deliberately its own lightweight row rather than reusing TabCard — a history candidate isn't a Tab yet, and doesn't need TabCard's category menu, drag handle, notes, or dependency affordances. */
function HistoryCandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: HistoryCandidate
  selected: boolean
  onToggle: () => void
}) {
  const primaryLine = candidate.title?.trim() || candidate.domain
  const [label, ...detail] = candidate.reasons

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-subtle px-1 py-2.5 last:border-b-0",
        candidate.alreadyInWorkspace && "opacity-60"
      )}
    >
      {candidate.alreadyInWorkspace ? (
        <div className="size-4 shrink-0" aria-hidden />
      ) : (
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${candidate.domain}`} />
      )}

      <TabFavicon domain={candidate.domain} />

      <button
        type="button"
        disabled={candidate.alreadyInWorkspace}
        onClick={onToggle}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <p className="truncate text-body font-medium text-foreground">{primaryLine}</p>
        <p className="truncate text-body-sm text-tertiary">{candidate.domain}</p>
        <p className="mt-0.5 truncate text-meta text-tertiary sm:hidden">{detail.join(" · ")}</p>
      </button>

      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
        <Badge variant={candidate.alreadyInWorkspace ? "secondary" : "accent"}>
          {candidate.alreadyInWorkspace ? "Already in TabDump" : label}
        </Badge>
        <p className="text-meta text-tertiary">{detail.join(" · ")}</p>
      </div>
    </div>
  )
}

function ScanSetup({
  rangeId,
  onRangeChange,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
  onScan,
}: {
  rangeId: HistoryTimeRangeId
  onRangeChange: (id: HistoryTimeRangeId) => void
  customStart: string
  customEnd: string
  onCustomStartChange: (v: string) => void
  onCustomEndChange: (v: string) => void
  onScan: () => void
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <ScanSearch className="mx-auto size-6 text-tertiary" aria-hidden />
        <h2 className="mt-3 text-h1 font-semibold text-foreground">Scan browser history</h2>
        <p className="mt-2 text-body-sm text-muted-foreground">
          Find pages you&apos;ve recently researched, revisited, or may want to keep.
        </p>

        <div className="mt-6 space-y-3 text-left">
          <Select
            value={rangeId}
            onValueChange={(v) => onRangeChange(v as HistoryTimeRangeId)}
            options={HISTORY_TIME_RANGES.map((r) => ({ value: r.id, label: r.label }))}
          />
          {rangeId === "custom" && (
            <div className="flex items-center gap-2">
              <Input type="date" value={customStart} onChange={(e) => onCustomStartChange(e.target.value)} aria-label="Start date" />
              <span className="text-tertiary">to</span>
              <Input type="date" value={customEnd} onChange={(e) => onCustomEndChange(e.target.value)} aria-label="End date" />
            </div>
          )}
        </div>

        <Button size="lg" className="mt-6 w-full" onClick={onScan}>
          Scan History
        </Button>
      </div>
    </div>
  )
}

function ScanLoading() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Loader2 className="size-6 animate-spin text-tertiary" aria-hidden />
      <p className="text-body font-medium text-foreground">Scanning your browser history…</p>
      <p className="text-body-sm text-muted-foreground">Finding pages worth keeping</p>
    </div>
  )
}

function ScanError({ reason, onRetry, onChangeRange }: { reason: "not-connected" | "error"; onRetry: () => void; onChangeRange: () => void }) {
  const copy =
    reason === "not-connected"
      ? {
          title: "TabDump extension not detected.",
          description: "Install or reconnect the extension to scan browser history.",
        }
      : {
          title: "History access isn't available.",
          description: "Update or reload the TabDump extension and try again.",
        }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
      <EmptyState icon={PlugZap} title={copy.title} description={copy.description} action={{ label: "Retry", onClick: onRetry }} />
      <Button variant="ghost" size="sm" onClick={onChangeRange}>
        Change range
      </Button>
    </div>
  )
}

export function HistoryDumpView({
  tabs,
  onClose,
  onDump,
}: {
  tabs: Tab[]
  onClose: () => void
  onDump: (entries: BrowserImportEntry[]) => void
}) {
  const { stage, result, error, scan, reset } = useHistoryDump()
  const [rangeId, setRangeId] = useState<HistoryTimeRangeId>(DEFAULT_HISTORY_TIME_RANGE)
  const [customStart, setCustomStart] = useState(() => toDateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const [customEnd, setCustomEnd] = useState(() => toDateInputValue(Date.now()))
  const [filter, setFilter] = useState<ReviewFilter>("all")
  const [search, setSearch] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [visibleOtherLimit, setVisibleOtherLimit] = useState(INITIAL_VISIBLE_LIMIT)

  function customRange(): CustomHistoryRange | undefined {
    const startTime = parseDateInputValue(customStart, false)
    const endTime = parseDateInputValue(customEnd, true)
    if (startTime === null || endTime === null) return undefined
    return { startTime, endTime }
  }

  function runScan() {
    setSelectedIds(new Set())
    setSearch("")
    setFilter("all")
    setVisibleOtherLimit(INITIAL_VISIBLE_LIMIT)
    const existingNormalizedUrls = new Set(tabs.map((t) => t.normalizedUrl))
    scan(rangeId, existingNormalizedUrls, rangeId === "custom" ? customRange() : undefined)
  }

  const candidates = useMemo(() => result?.candidates ?? [], [result])
  const suggested = useMemo(() => candidates.filter((c) => c.tier === "suggested" && !c.alreadyInWorkspace), [candidates])
  const other = useMemo(() => candidates.filter((c) => c.tier === "other" && !c.alreadyInWorkspace), [candidates])
  const already = useMemo(() => candidates.filter((c) => c.alreadyInWorkspace), [candidates])
  const selectable = useMemo(() => [...suggested, ...other], [suggested, other])

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleDump() {
    const chosen = selectable.filter((c) => selectedIds.has(c.id))
    if (chosen.length === 0) return
    const entries: BrowserImportEntry[] = chosen.map((c) => ({
      url: c.url,
      title: c.title,
      source: "history",
      historyVisitCount: c.visitCount,
      historyLastVisitedAt: c.lastVisitedAt,
    }))
    onDump(entries)
  }

  const filteredSuggested = filter !== "already" ? suggested.filter((c) => matchesSearch(c, search)) : []
  const filteredOtherAll = filter === "all" ? other.filter((c) => matchesSearch(c, search)) : []
  const filteredOther = filteredOtherAll.slice(0, visibleOtherLimit)
  const filteredAlready = filter === "already" ? already.filter((c) => matchesSearch(c, search)) : []

  const reviewableCount = suggested.length + other.length
  const nothingScanned = candidates.length === 0 && (result?.scannedCount ?? 0) === 0
  const nothingSurfaced = candidates.length === 0 && (result?.scannedCount ?? 0) > 0
  const allAlreadyCaptured = reviewableCount === 0 && already.length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 sm:px-6">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <ScanSearch className="size-4 shrink-0 text-tertiary" />
        <p className="text-h1 text-foreground">History Dump</p>
      </div>

      {stage === "idle" && (
        <ScanSetup
          rangeId={rangeId}
          onRangeChange={setRangeId}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStartChange={setCustomStart}
          onCustomEndChange={setCustomEnd}
          onScan={runScan}
        />
      )}

      {stage === "scanning" && <ScanLoading />}

      {stage === "error" && error && <ScanError reason={error.reason} onRetry={runScan} onChangeRange={reset} />}

      {stage === "ready" && (
        <>
          {nothingScanned ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={ScanSearch}
                title="No history found"
                description="There aren't any browser history entries in this time range."
                action={{ label: "Try a different range", onClick: reset }}
              />
            </div>
          ) : nothingSurfaced ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={ScanSearch}
                title="Nothing worth surfacing yet"
                description="We scanned your history but couldn't find useful pages in this range. Try a longer time range."
                action={{ label: "Choose a different range", onClick: reset }}
              />
            </div>
          ) : allAlreadyCaptured ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={ScanSearch}
                title="You're already covered"
                description="All of the useful pages we found are already in TabDump."
                action={{ label: "Scan a different range", onClick: reset }}
              />
            </div>
          ) : (
            <>
              <div className="border-b border-subtle px-4 py-3 sm:px-6">
                <p className="text-body-sm text-muted-foreground">
                  We found {reviewableCount} page{reviewableCount === 1 ? "" : "s"} that may be worth keeping.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-0.5 rounded-lg border border-subtle bg-card p-0.5">
                    {(
                      [
                        { id: "all", label: "All" },
                        { id: "suggested", label: "Suggested" },
                        { id: "already", label: `Already in TabDump${already.length > 0 ? ` (${already.length})` : ""}` },
                      ] as { id: ReviewFilter; label: string }[]
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setFilter(tab.id)}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-label font-medium transition-colors duration-(--duration-fast) ease-(--ease-standard)",
                          filter === tab.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <SearchBar value={search} onChange={setSearch} className="w-40 sm:w-56" />
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set(suggested.map((c) => c.id)))}>
                      Select suggested
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set(selectable.map((c) => c.id)))}>
                      Select all
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0}>
                      Deselect all
                    </Button>
                  </div>
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 space-y-6">
                  {filteredSuggested.length > 0 && (
                    <section>
                      <p className="mb-2 px-1 text-label text-tertiary">HIGH CONFIDENCE</p>
                      <div className="rounded-lg border border-subtle bg-card px-2 pb-1">
                        {filteredSuggested.map((c) => (
                          <HistoryCandidateRow key={c.id} candidate={c} selected={selectedIds.has(c.id)} onToggle={() => toggleSelected(c.id)} />
                        ))}
                      </div>
                    </section>
                  )}

                  {filteredOther.length > 0 && (
                    <section>
                      <p className="mb-2 px-1 text-label text-tertiary">OTHER POTENTIAL TABS</p>
                      <div className="rounded-lg border border-subtle bg-card px-2 pb-1">
                        {filteredOther.map((c) => (
                          <HistoryCandidateRow key={c.id} candidate={c} selected={selectedIds.has(c.id)} onToggle={() => toggleSelected(c.id)} />
                        ))}
                      </div>
                      {filteredOtherAll.length > filteredOther.length && (
                        <div className="mt-2 flex justify-center">
                          <Button variant="ghost" size="sm" onClick={() => setVisibleOtherLimit((n) => n + INITIAL_VISIBLE_LIMIT)}>
                            Show {filteredOtherAll.length - filteredOther.length} more
                          </Button>
                        </div>
                      )}
                    </section>
                  )}

                  {filteredAlready.length > 0 && (
                    <section>
                      <p className="mb-2 px-1 text-label text-tertiary">ALREADY IN TABDUMP</p>
                      <div className="rounded-lg border border-subtle bg-card px-2 pb-1">
                        {filteredAlready.map((c) => (
                          <HistoryCandidateRow key={c.id} candidate={c} selected={false} onToggle={() => {}} />
                        ))}
                      </div>
                    </section>
                  )}

                  {filteredSuggested.length === 0 && filteredOther.length === 0 && filteredAlready.length === 0 && (
                    <p className="py-12 text-center text-body-sm text-muted-foreground">No results match &ldquo;{search}&rdquo;.</p>
                  )}
                </div>
              </ScrollArea>

              <div className="flex items-center gap-3 border-t border-subtle px-4 py-3 sm:px-6">
                <p className="text-body-sm text-muted-foreground">{tabsLabel(selectedIds.size)} selected</p>
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button onClick={handleDump} disabled={selectedIds.size === 0}>
                    Dump {tabsLabel(selectedIds.size)}
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
