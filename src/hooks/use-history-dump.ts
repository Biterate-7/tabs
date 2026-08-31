"use client"

import { useCallback, useRef, useState } from "react"
import { fetchBrowserHistory } from "@/lib/browser/history"
import { buildHistoryCandidates } from "@/lib/history-dump/candidates"
import { resolveTimeRange } from "@/lib/history-dump/time-range"
import type { CustomHistoryRange } from "@/lib/history-dump/time-range"
import type { HistoryScanResult, HistoryScanStage, HistoryTimeRangeId } from "@/lib/history-dump/types"

export type HistoryDumpError = { reason: "not-connected" | "error"; message?: string }

/**
 * Drives History Dump's scan lifecycle: idle → scanning → ready | error.
 * Mirrors use-auto-organize.ts's runId-guard idiom so a scan superseded by a
 * newer one (user changes the range and re-scans before the first request
 * lands) never clobbers fresher state with a stale response.
 *
 * Fetching (extension round trip) and candidate-building (pure, synchronous —
 * see lib/history-dump/candidates.ts) are kept as two separate awaited steps
 * rather than folded together so a slow *fetch* is what the "scanning" stage
 * actually reflects; building candidates over even a few thousand entries is
 * fast enough not to need its own stage.
 */
export function useHistoryDump() {
  const [stage, setStage] = useState<HistoryScanStage>("idle")
  const [result, setResult] = useState<HistoryScanResult | null>(null)
  const [error, setError] = useState<HistoryDumpError | null>(null)
  const runIdRef = useRef(0)

  const scan = useCallback(
    async (rangeId: HistoryTimeRangeId, existingNormalizedUrls: ReadonlySet<string>, custom?: CustomHistoryRange) => {
      const runId = ++runIdRef.current
      setStage("scanning")
      setError(null)

      const now = Date.now()
      const { startTime, endTime } = resolveTimeRange(rangeId, now, custom)
      const response = await fetchBrowserHistory(startTime, endTime)
      if (runIdRef.current !== runId) return

      if (!response.ok) {
        setError({ reason: response.reason, message: response.error })
        setStage("error")
        return
      }

      const scanResult = buildHistoryCandidates(response.items, existingNormalizedUrls, now)
      if (runIdRef.current !== runId) return
      setResult(scanResult)
      setStage("ready")
    },
    []
  )

  const reset = useCallback(() => {
    runIdRef.current += 1
    setStage("idle")
    setResult(null)
    setError(null)
  }, [])

  return { stage, result, error, scan, reset }
}
