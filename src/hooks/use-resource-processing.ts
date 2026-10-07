"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getProjectContents, putContent, deleteContent } from "@/lib/resources/content-store"
import {
  attachPdfFile,
  attachTranscript,
  extractionEndpoint,
  httpExtractor,
  markProcessing,
  MAX_AUTOMATIC_ATTEMPTS,
  processSource,
  requeue,
  shouldProcess,
} from "@/lib/resources/process"
import { recordProjectEvent } from "@/lib/projects/activity"
import { recordLoopMilestone } from "@/lib/product/loop-log"
import { isDesktop } from "@/lib/platform/detect"
import type { ProcessDeps, ProcessResult } from "@/lib/resources/process"
import type { Tab } from "@/lib/tabs/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * Reads project sources in the background (Hubble 2.0).
 *
 * Watches the store for sources that are `pending`, reads up to three at a
 * time — the current project's first — and writes each result back through
 * the app's one commit seam, against the store as it is *then* (a source
 * removed meanwhile stays removed). Every source ends in ready, partial or
 * failed; one that keeps getting interrupted runs out of automatic attempts
 * and says so, instead of spinning forever.
 *
 * Once per project per page load it also checks that every "ready" source
 * really has its content on this device (IndexedDB can be cleared, or an
 * account's data copied without it), and reads again any that do not.
 */

const CONCURRENCY = 3

export type ResourceActions = {
  retry: (workspaceId: string, tabId: string) => void
  attachPdf: (workspaceId: string, tabId: string, file: File) => Promise<ProcessResult | undefined>
  attachTranscript: (workspaceId: string, tabId: string, text: string) => Promise<{ error?: string }>
  /** Forget stored content for sources a project no longer has. */
  forget: (workspaceId: string, tabIds: readonly string[]) => void
}

function updateTab(store: WorkspaceStore, workspaceId: string, tabId: string, update: (tab: Tab) => Tab | null): WorkspaceStore | null {
  let changed = false
  const workspaces = store.workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace
    const tabs = workspace.tabs.map((tab) => {
      if (tab.id !== tabId) return tab
      const next = update(tab)
      if (!next || next === tab) return tab
      changed = true
      return next
    })
    return changed ? { ...workspace, tabs } : workspace
  })
  return changed ? { ...store, workspaces } : null
}

export function useResourceProcessing(options: {
  store: WorkspaceStore | null
  /** The latest committed store, read at the moment of each write. */
  getStore: () => WorkspaceStore | null
  commit: (next: WorkspaceStore) => void
  enabled: boolean
  /** Injected in tests. */
  deps?: Partial<ProcessDeps>
}): ResourceActions {
  const { store, enabled } = options
  const running = useRef(new Set<string>())
  const verified = useRef(new Set<string>())
  const depsRef = useRef<ProcessDeps | null>(null)
  // Bumped when a run finishes, so a freed slot is filled even if nothing else changed.
  const [finished, setFinished] = useState(0)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const deps = useCallback((): ProcessDeps => {
    if (!depsRef.current) {
      depsRef.current = {
        extract: httpExtractor(extractionEndpoint(isDesktop() ? "desktop" : "web")),
        putContent,
        now: () => Date.now(),
        ...optionsRef.current.deps,
      }
    }
    return depsRef.current
  }, [])

  // The shell's store accessors change identity every render; read them at call time so nothing here re-runs for it.
  const getStore = useCallback(() => optionsRef.current.getStore(), [])
  const apply = useCallback(
    (workspaceId: string, tabId: string, update: (tab: Tab) => Tab | null) => {
      const current = optionsRef.current.getStore()
      if (!current) return
      const next = updateTab(current, workspaceId, tabId, update)
      if (next) optionsRef.current.commit(next)
    },
    []
  )

  const settle = useCallback(
    (workspaceId: string, result: ProcessResult) => {
      apply(workspaceId, result.tabId, (tab) =>
        tab.resource ? { ...tab, resource: result.resource, ...(result.title ? { title: result.title } : {}) } : null
      )
      if (result.resource.status === "ready") {
        recordProjectEvent({ workspaceId, kind: "source_ready", tabId: result.tabId })
        recordLoopMilestone("resource_ready")
      } else if (result.resource.status === "failed") {
        recordProjectEvent({ workspaceId, kind: "source_failed", tabId: result.tabId })
        recordLoopMilestone("resource_failed")
      }
    },
    [apply]
  )

  // Pick up pending sources, current project first.
  useEffect(() => {
    if (!enabled || !store) return
    const ordered = [...store.workspaces].sort((a, b) => (a.id === store.currentId ? -1 : b.id === store.currentId ? 1 : 0))
    for (const workspace of ordered) {
      for (const tab of workspace.tabs) {
        const resource = tab.resource
        if (!resource) continue
        const key = `${workspace.id}:${tab.id}`
        // Out of automatic attempts while still pending: say so rather than wait forever.
        if (resource.status === "pending" && (resource.attempts ?? 0) >= MAX_AUTOMATIC_ATTEMPTS && !running.current.has(key)) {
          apply(workspace.id, tab.id, (current) =>
            current.resource?.status === "pending"
              ? { ...current, resource: { ...current.resource, status: "failed", updatedAt: Date.now(), error: { code: "interrupted", message: "Reading was interrupted several times. Try again.", retryable: true } } }
              : null
          )
          continue
        }
        if (!shouldProcess(resource) || running.current.has(key) || running.current.size >= CONCURRENCY) continue
        running.current.add(key)
        apply(workspace.id, tab.id, (current) => (current.resource && shouldProcess(current.resource) ? { ...current, resource: markProcessing(current.resource, Date.now()) } : null))
        const snapshot = { ...tab }
        void processSource(workspace.id, snapshot, deps())
          .then((result) => {
            // Only if it is still the run in progress: removed or retried meanwhile means this answer is stale.
            const now = getStore()?.workspaces.find((entry) => entry.id === workspace.id)?.tabs.find((entry) => entry.id === tab.id)
            if (now?.resource?.status === "processing") settle(workspace.id, result)
            else if (!now) void deleteContent(workspace.id, [tab.id])
          })
          .catch(() => {
            apply(workspace.id, tab.id, (current) =>
              current.resource?.status === "processing"
                ? { ...current, resource: { ...current.resource, status: "failed", updatedAt: Date.now(), error: { code: "interrupted", message: "Reading was interrupted.", retryable: true } } }
                : null
            )
          })
          .finally(() => {
            running.current.delete(key)
            setFinished((count) => count + 1)
          })
      }
    }
  }, [store, enabled, finished, apply, deps, getStore, settle])

  // A "ready" source whose content is gone from this device is read again.
  useEffect(() => {
    if (!enabled || !store) return
    for (const workspace of store.workspaces) {
      if (verified.current.has(workspace.id)) continue
      const ready = workspace.tabs.filter((tab) => tab.resource?.status === "ready")
      if (ready.length === 0) continue
      verified.current.add(workspace.id)
      void getProjectContents(workspace.id)
        .then((contents) => {
          for (const tab of ready) {
            if (contents.has(tab.id)) continue
            apply(workspace.id, tab.id, (current) => {
              if (current.resource?.status !== "ready") return null
              const rest = { ...current.resource }
              delete rest.content
              return { ...current, resource: requeue(rest, Date.now()) }
            })
          }
        })
        .catch(() => undefined)
    }
  }, [store, enabled, apply])

  const retry = useCallback(
    (workspaceId: string, tabId: string) => apply(workspaceId, tabId, (tab) => (tab.resource && tab.resource.status !== "processing" ? { ...tab, resource: requeue(tab.resource, Date.now()) } : null)),
    [apply]
  )

  const findTab = useCallback(
    (workspaceId: string, tabId: string) => getStore()?.workspaces.find((entry) => entry.id === workspaceId)?.tabs.find((entry) => entry.id === tabId),
    [getStore]
  )

  const attachPdf = useCallback(
    async (workspaceId: string, tabId: string, file: File) => {
      const tab = findTab(workspaceId, tabId)
      if (!tab?.resource) return undefined
      const result = await attachPdfFile(workspaceId, tab, file, deps())
      settle(workspaceId, result)
      return result
    },
    [deps, findTab, settle]
  )

  const attachTranscriptText = useCallback(
    async (workspaceId: string, tabId: string, text: string) => {
      const tab = findTab(workspaceId, tabId)
      if (!tab?.resource) return { error: "That source is no longer in the project." }
      const result = await attachTranscript(workspaceId, tab, text, deps())
      if ("error" in result) return { error: result.error }
      settle(workspaceId, result)
      return {}
    },
    [deps, findTab, settle]
  )

  const forget = useCallback((workspaceId: string, tabIds: readonly string[]) => {
    void deleteContent(workspaceId, tabIds).catch(() => undefined)
  }, [])

  return { retry, attachPdf, attachTranscript: attachTranscriptText, forget }
}
