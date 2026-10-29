"use client"

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useAllProjectActivity } from "@/hooks/use-all-project-activity"
import { useBrowserConnected } from "@/hooks/use-tab-sessions"
import { createId } from "@/lib/id"
import { BROWSER_MESSAGE_SOURCE } from "@/lib/browser/protocol"
import { pullActivity } from "@/lib/intelligence/bridge"
import { runInference } from "@/lib/intelligence/engine"
import { getContextSnapshot, getServerContextSnapshot, subscribeContext, writeContext } from "@/lib/intelligence/persistence"
import { getSettingsView, refreshSettings, subscribeSettingsView } from "@/lib/intelligence/settings-store"
import { applyPull } from "@/lib/intelligence/sync"
import { isLegacyProjectEvent } from "@/lib/projects/activity"
import type { SettingsView } from "@/lib/intelligence/settings-store"
import type { ContextState } from "@/lib/intelligence/types"
import type { Workspace } from "@/lib/workspace/types"

const MSG_CONTEXT_CHANGED = "HUBBLE_CONTEXT_CHANGED"
/** Inference waits for a quiet moment after its input changes: a burst of pulls is one run. */
const INFERENCE_DELAY_MS = 400
const SETTINGS_REFRESH_MS = 10_000

/** What context intelligence knows, kept current across this page and other Hubble tabs. */
export function useContextState(): ContextState {
  return useSyncExternalStore(subscribeContext, getContextSnapshot, getServerContextSnapshot)
}

/** The person's detection choices as the extension holds them. */
export function useContextSettingsView(): SettingsView {
  return useSyncExternalStore(subscribeSettingsView, getSettingsView, () => ({ status: "unknown" }) as const)
}

/**
 * Keeps Hubble in step with the extension and the suggestions with the work.
 * Mounted once, by the shell, on the web only (Hubble Desktop can't reach the
 * extension).
 *
 *   pull     when the extension connects, when it says something changed
 *            (a nudge carrying nothing), and when this tab comes back into
 *            view. One at a time; a request during one runs once after it.
 *   infer    after any change to the pages, the person's decisions or their
 *            projects — on a short delay, in one read-modify-write, so two
 *            tabs never write over each other's decisions.
 *
 * Nothing here is sent anywhere: the pull is a message to the extension in
 * this browser, and inference runs on this page.
 */
export function useContextSync({ workspaces, enabled }: { workspaces: readonly Workspace[]; enabled: boolean }) {
  const connected = useBrowserConnected()
  const state = useContextState()
  const events = useAllProjectActivity()
  const pulling = useRef(false)
  const again = useRef(false)
  const lastSettingsAt = useRef(0)

  useEffect(() => {
    if (!enabled || !connected) return
    let cancelled = false

    async function pull() {
      if (pulling.current) {
        again.current = true
        return
      }
      pulling.current = true
      try {
        do {
          again.current = false
          const cursor = getContextSnapshot().cursor
          const answer = await pullActivity(cursor ? { since: cursor.seq, epoch: cursor.epoch } : undefined)
          if (cancelled || !answer.ok) break
          writeContext((current) => applyPull(current, answer.value))
        } while (again.current && !cancelled)
      } finally {
        pulling.current = false
      }
    }

    function refresh() {
      void pull()
      if (Date.now() - lastSettingsAt.current >= SETTINGS_REFRESH_MS) {
        lastSettingsAt.current = Date.now()
        void refreshSettings()
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== window) return
      const data = event.data as { source?: unknown; type?: unknown } | null
      if (data?.source === BROWSER_MESSAGE_SOURCE && data.type === MSG_CONTEXT_CHANGED) {
        lastSettingsAt.current = 0
        refresh()
      }
    }
    function onVisible() {
      if (document.visibilityState === "visible") refresh()
    }

    lastSettingsAt.current = 0
    refresh()
    window.addEventListener("message", onMessage)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      cancelled = true
      window.removeEventListener("message", onMessage)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [enabled, connected])

  // When each project was last worked on: its newest event the person made, or its own last change.
  const projectLastAt = useMemo(() => {
    const map = new Map<string, number>()
    for (const workspace of workspaces) map.set(workspace.id, workspace.updatedAt)
    for (const event of events) {
      if (isLegacyProjectEvent(event) || event.kind === "source_ready" || event.kind === "source_failed") continue
      if (map.has(event.workspaceId)) map.set(event.workspaceId, Math.max(map.get(event.workspaceId)!, event.at))
    }
    return map
  }, [workspaces, events])

  // Manual mode, or another account's choice on this Chrome: nothing is suggested from what was kept before, and
  // anything waiting is put away. ("Hubble notices nothing" — the consent copy — includes not acting on old pages.)
  const view = useContextSettingsView()
  const quiet = view.status === "ready" && (view.value.settings.mode === "off" || view.value.otherAccount)
  const { records, associations, rejections, preference, suggestions } = state
  useEffect(() => {
    if (!enabled) return
    if (records.length === 0 && suggestions.every((suggestion) => suggestion.status !== "open")) return
    const timer = setTimeout(() => {
      writeContext((current) => {
        const result = runInference({ state: current, workspaces, projectLastAt, now: Date.now(), preference: quiet ? "off" : current.preference, mintId: createId })
        return result.changed ? { ...current, suggestions: result.suggestions } : current
      })
    }, INFERENCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, quiet, records, associations, rejections, preference, suggestions, workspaces, projectLastAt])
}
