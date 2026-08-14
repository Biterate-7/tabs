"use client"

import { useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import { extractGoogleWorkspaceFile } from "@/lib/google/workspace-url"
import { resolveGoogleFileTitles } from "@/lib/google/resolve-titles"
import type { Tab } from "@/lib/tabs/types"

type TitleUpdate = { id: string; title: string }

export function useGoogleTitleEnrichment(
  tabs: Tab[],
  onResolved: (updates: TitleUpdate[]) => void
): { needsSignIn: boolean } {
  const { status } = useSession()
  const attemptedFileIds = useRef<Set<string>>(new Set())
  const [needsSignIn, setNeedsSignIn] = useState(false)

  useEffect(() => {
    if (status === "loading") return

    const candidates = tabs
      .map((tab) => {
        if (tab.title?.trim()) return null
        const match = extractGoogleWorkspaceFile(tab.url)
        return match ? { tab, fileId: match.fileId } : null
      })
      .filter((c): c is { tab: Tab; fileId: string } => c !== null)

    if (candidates.length === 0) {
      setNeedsSignIn(false)
      return
    }

    if (status !== "authenticated") {
      setNeedsSignIn(true)
      return
    }

    const pending = candidates.filter((c) => !attemptedFileIds.current.has(c.fileId))
    if (pending.length === 0) return

    pending.forEach((c) => attemptedFileIds.current.add(c.fileId))
    let cancelled = false

    resolveGoogleFileTitles(pending.map((c) => c.fileId)).then((result) => {
      if (cancelled) return

      if (!result.authenticated) {
        pending.forEach((c) => attemptedFileIds.current.delete(c.fileId))
        setNeedsSignIn(true)
        return
      }

      setNeedsSignIn(false)
      const updates = pending
        .map((c) => {
          const metadata = result.metadataByFileId.get(c.fileId)
          return metadata ? { id: c.tab.id, title: metadata.name } : null
        })
        .filter((u): u is TitleUpdate => u !== null)

      if (updates.length > 0) onResolved(updates)
    })

    return () => {
      cancelled = true
    }
  }, [tabs, status, onResolved])

  return { needsSignIn }
}
