"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import { extractGoogleWorkspaceFile } from "@/lib/google/workspace-url"
import { resolveGoogleFileTitles } from "@/lib/google/resolve-titles"
import type { Tab } from "@/lib/tabs/types"

type TitleUpdate = { id: string; title: string }

function findCandidates(tabs: Tab[]) {
  return tabs
    .map((tab) => {
      if (tab.title?.trim()) return null
      const match = extractGoogleWorkspaceFile(tab.url)
      return match ? { tab, fileId: match.fileId } : null
    })
    .filter((c): c is { tab: Tab; fileId: string } => c !== null)
}

export function useGoogleTitleEnrichment(
  tabs: Tab[],
  onResolved: (updates: TitleUpdate[]) => void
): { needsSignIn: boolean } {
  const { status } = useSession()
  const attemptedFileIds = useRef<Set<string>>(new Set())
  // Only ever set from inside the resolveGoogleFileTitles `.then()` below —
  // that's the one genuinely async/external signal here (the resolve
  // endpoint discovering, server-side, that the session's refresh token is
  // no longer valid). Every other contributor to whether the sign-in
  // banner should show (is there anything to sign in for, is the session
  // currently unauthenticated) is derivable synchronously from `tabs` and
  // `status` during render, so those are combined into the returned value
  // below instead of being pushed through setState-in-an-effect — doing it
  // there would trip react-hooks/set-state-in-effect ("you might not need
  // an effect") and would leave stale `true` values that only an extra
  // effect run could clear.
  const [refreshFailed, setRefreshFailed] = useState(false)

  const hasCandidates = useMemo(() => findCandidates(tabs).length > 0, [tabs])

  useEffect(() => {
    if (status === "loading") return

    const candidates = findCandidates(tabs)
    if (candidates.length === 0) return
    if (status !== "authenticated") return

    const pending = candidates.filter((c) => !attemptedFileIds.current.has(c.fileId))
    if (pending.length === 0) return

    pending.forEach((c) => attemptedFileIds.current.add(c.fileId))
    let cancelled = false
    let settled = false

    resolveGoogleFileTitles(pending.map((c) => c.fileId)).then((result) => {
      settled = true
      if (cancelled) return

      if (!result.authenticated) {
        pending.forEach((c) => attemptedFileIds.current.delete(c.fileId))
        setRefreshFailed(true)
        return
      }

      setRefreshFailed(false)
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
      //
      // attemptedFileIds isn't a DOM ref that React reassigns out from
      // under us — it's a plain mutable Set we own and only ever mutate
      // in place (add/delete), never replace — so reading `.current` here
      // is exactly the current, correct cache to reconcile.
      if (!settled) {
        // eslint-disable-next-line react-hooks/exhaustive-deps
        pending.forEach((c) => attemptedFileIds.current.delete(c.fileId))
      }
    }
  }, [tabs, status, onResolved])

  return { needsSignIn: hasCandidates && (status === "unauthenticated" || refreshFailed) }
}
