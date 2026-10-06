"use client"

import { useEffect, useMemo, useState } from "react"
import { getProjectContents } from "@/lib/resources/content-store"
import type { ResourceContent } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

export type ProjectContents = ReadonlyMap<string, ReadonlyMap<string, ResourceContent>>

const EMPTY: ProjectContents = new Map()

/**
 * The extracted content of some projects' sources, loaded from the content
 * store (IndexedDB) — only for the projects named, and only when something
 * that reads it is on screen (a live session's context, project search,
 * a source's details).
 *
 * Reloads a project when what its tabs say about their content changes (a
 * source finished reading, a PDF was attached, a source was removed), so
 * what is loaded never lags what the cards claim.
 */
export function useProjectContents(workspaces: readonly Pick<Workspace, "id" | "tabs">[]): ProjectContents {
  // What each project's tabs claim about their content: a change here is the only reason to read again.
  const key = useMemo(
    () =>
      workspaces
        .map((workspace) => {
          const sources = workspace.tabs
            .filter((tab) => tab.resource?.content)
            .map((tab) => `${tab.id}@${tab.resource!.content!.extractedAt}`)
            .join(",")
          return `${workspace.id}:${sources}`
        })
        .sort()
        .join("|"),
    [workspaces]
  )
  const [loaded, setLoaded] = useState<{ key: string; contents: ProjectContents }>({ key: "", contents: EMPTY })

  useEffect(() => {
    let cancelled = false
    const ids = key
      .split("|")
      .filter(Boolean)
      .map((entry) => ({ id: entry.slice(0, entry.indexOf(":")), any: entry.length > entry.indexOf(":") + 1 }))
    void Promise.all(
      ids.map(async ({ id, any }) => [id, any ? await getProjectContents(id).catch(() => new Map<string, ResourceContent>()) : new Map<string, ResourceContent>()] as const)
    ).then((entries) => {
      if (!cancelled) setLoaded({ key, contents: new Map(entries) })
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return loaded.contents
}
