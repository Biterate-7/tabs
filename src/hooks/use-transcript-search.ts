"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { getContents } from "@/lib/resources/content-store"
import { searchTranscripts, type TranscriptSearchHit } from "@/lib/resources/search"
import type { ResourceContent } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

type Loaded = ReadonlyMap<string, ReadonlyMap<string, ResourceContent>>

const EMPTY: Loaded = new Map()

/**
 * Search what was said in every subject's videos — for ⌘K.
 *
 * Loads only sources whose tab says it has a transcript (one IndexedDB
 * transaction per subject, the records asked for — never every PDF's
 * pages), only while `enabled`, and again only when a transcript is added,
 * replaced or removed (the tabs' content summaries change). Searching the
 * loaded transcripts is synchronous, so the palette can ask on every
 * keystroke.
 *
 * Removed sources disappear on the next render: search runs over the
 * subjects' current tabs, whatever is still loaded.
 */
export function useTranscriptSearch(workspaces: readonly Workspace[], enabled: boolean): (query: string, limit?: number) => TranscriptSearchHit[] {
  const wanted = useMemo(() => {
    if (!enabled) return ""
    return workspaces
      .map((workspace) => {
        const ids = workspace.tabs.filter((tab) => tab.resource?.content?.transcriptLines).map((tab) => `${tab.id}@${tab.resource!.content!.extractedAt}`)
        return ids.length > 0 ? `${workspace.id}:${ids.join(",")}` : ""
      })
      .filter(Boolean)
      .sort()
      .join("|")
  }, [workspaces, enabled])

  const [loaded, setLoaded] = useState<{ key: string; contents: Loaded }>({ key: "", contents: EMPTY })

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    const requests = wanted.split("|").map((entry) => {
      const split = entry.indexOf(":")
      const workspaceId = entry.slice(0, split)
      const tabIds = entry
        .slice(split + 1)
        .split(",")
        .map((id) => id.slice(0, id.lastIndexOf("@")))
      return getContents(workspaceId, tabIds)
        .catch(() => new Map<string, ResourceContent>())
        .then((contents) => [workspaceId, contents] as const)
    })
    void Promise.all(requests).then((entries) => {
      if (!cancelled) setLoaded({ key: wanted, contents: new Map(entries) })
    })
    return () => {
      cancelled = true
    }
  }, [wanted])

  // While a newer set loads, the previous one still answers — it is filtered by the current tabs anyway.
  const contents = wanted ? loaded.contents : EMPTY
  return useCallback((query: string, limit?: number) => searchTranscripts({ query, workspaces, contents, ...(limit ? { limit } : {}) }), [workspaces, contents])
}
