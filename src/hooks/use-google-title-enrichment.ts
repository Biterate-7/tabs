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
    if (pending.length === 0) {
      // Every remaining candidate was already attempted (resolved to null,
      // or is awaiting a still-in-flight request from a prior effect run).
      // We know status === "authenticated" here (checked above), so clear
      // any stale sign-in prompt left over from an earlier unauthenticated
      // run — otherwise it can get stuck true after a valid re-login.
      setNeedsSignIn(false)
      return
    }

    pending.forEach((c) => attemptedFileIds.current.add(c.fileId))
    let cancelled = false
    let settled = false

    resolveGoogleFileTitles(pending.map((c) => c.fileId)).then((result) => {
      settled = true
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
      // If this effect is superseded (e.g. `tabs` or `onResolved` changed
      // identity) before the fetch settles, its result is discarded above
      // via the `cancelled` check — but these fileIds were already marked
      // "attempted", so without this cleanup they'd never be retried by a
      // later effect run even though the in-flight request may have
      // succeeded. Un-mark them so the next effect run picks them back up.
      // Only do this if the fetch genuinely hasn't settled yet — if it
      // already resolved (e.g. to a permanent null result) before cleanup
      // ran, leave attemptedFileIds alone so we don't needlessly re-fetch
      // work that already completed.
      if (!settled) {
        pending.forEach((c) => attemptedFileIds.current.delete(c.fileId))
      }
    }
  }, [tabs, status, onResolved])

  return { needsSignIn }
}
