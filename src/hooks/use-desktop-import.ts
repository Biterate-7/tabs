"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  readDesktopImportRequest,
  type DesktopConversationRequest,
  type DesktopImportOutcome,
  type DesktopImportRequest,
} from "@/lib/desktop/import-protocol"
import type { ConversationInput } from "@/lib/conversations/types"
import type { CaptureSaveResult } from "@/hooks/use-extension-memory"

/** The shell's one conversation save — the one the extension's Save uses on the web. */
export type DesktopConversationSave = (workspaceId: string, input: ConversationInput, truncated: boolean) => Promise<CaptureSaveResult>

/** How the webview reaches the import bridge: Rust commands and one event (src/lib/platform/desktop.ts). */
export type DesktopImportBridge = {
  take(): Promise<unknown[]>
  finish(requestId: string, outcome: DesktopImportOutcome): Promise<void>
  onRequested(handler: () => void): Promise<() => void>
}

/** Closes a batch a little before Rust lets it go, so an Add is never answered too late. */
const EXPIRY_MARGIN_MS = 2000

function log(stage: string, data: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "production") console.info(`[hubble-import] ${stage}`, data)
}

/**
 * Chrome → Hubble Desktop, in the webview: the batches of tabs and the
 * conversations the extension sent, oldest first, for the import dialog to
 * put in front of the person.
 *
 * Batches wait in Rust, not here, so nothing is lost while this window
 * starts: the moment `ready` (the store is loaded and can take an import),
 * this asks Rust for everything waiting — including a batch that arrived
 * while Hubble was still launching — and asks again whenever Rust says a new
 * one came in. A batch is answered exactly once (`answer`), and only then
 * leaves the queue.
 *
 * A conversation is saved through `saveConversation` (`saveCapture` below),
 * which answers Rust with what the save did.
 *
 * `bridge` is undefined on the web, where there is no desktop import.
 */
export function useDesktopImport(
  bridge: DesktopImportBridge | undefined,
  ready: boolean,
  onExpire?: (request: DesktopImportRequest) => void,
  saveConversation?: DesktopConversationSave
) {
  const [queue, setQueue] = useState<DesktopImportRequest[]>([])
  // Answered here but perhaps not yet gone from Rust's next `take`.
  const answeredRef = useRef(new Set<string>())

  useEffect(() => {
    if (!bridge || !ready) return
    let active = true
    let unlisten: (() => void) | undefined

    async function pull() {
      let raw: unknown[]
      try {
        raw = await bridge!.take()
      } catch (err) {
        log("take-failed", { detail: err instanceof Error ? err.message : String(err) })
        return
      }
      if (!active) return
      const now = Date.now()
      const fresh: DesktopImportRequest[] = []
      for (const entry of Array.isArray(raw) ? raw : []) {
        const read = readDesktopImportRequest(entry, now)
        if (!read) continue
        const requestId = read.ok ? read.request.requestId : read.requestId
        if (answeredRef.current.has(requestId)) continue
        // Nothing usable in it (no web address, not a conversation): answer at once rather than show an empty choice.
        if (!read.ok) {
          answeredRef.current.add(requestId)
          log("request-unusable", { requestId })
          void bridge!.finish(requestId, { status: "failed", added: 0, duplicates: 0, failed: read.failed }).catch(() => undefined)
          continue
        }
        fresh.push(read.request)
      }
      if (fresh.length === 0) return
      // Counts only: neither an address nor a word of a conversation is logged.
      log("requests-received", {
        requests: fresh.map((request) => ({ requestId: request.requestId, kind: request.kind, items: request.kind === "tabs" ? request.tabs.length : request.conversation.turns.length })),
      })
      setQueue((current) => {
        const known = new Set(current.map((request) => request.requestId))
        const added = fresh.filter((request) => !known.has(request.requestId))
        return added.length > 0 ? [...current, ...added] : current
      })
    }

    void pull()
    bridge
      .onRequested(() => void pull())
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unlisten?.()
    }
  }, [bridge, ready])

  const answer = useCallback(
    (requestId: string, outcome: DesktopImportOutcome) => {
      answeredRef.current.add(requestId)
      setQueue((current) => current.filter((request) => request.requestId !== requestId))
      log("request-answered", {
        requestId,
        status: outcome.status,
        ...("saved" in outcome ? { saved: outcome.saved, turns: outcome.turns } : { added: outcome.added, duplicates: outcome.duplicates, failed: outcome.failed }),
      })
      // Refused only if Rust has let it go already (the margin below makes that the rare case).
      void bridge?.finish(requestId, outcome).catch((err) => log("finish-failed", { requestId, detail: err instanceof Error ? err.message : String(err) }))
    },
    [bridge]
  )

  // A request Rust has stopped waiting for can no longer be answered: adding
  // it here would put tabs or a conversation in a project while Chrome says
  // nothing was saved. It leaves the queue when Rust lets it go.
  const current = queue[0]
  const onExpireRef = useRef(onExpire)
  const saveConversationRef = useRef(saveConversation)
  useEffect(() => {
    onExpireRef.current = onExpire
    saveConversationRef.current = saveConversation
  })

  /**
   * Saves a conversation into the project the person chose (`project` is its
   * name, for Chrome's "Saved to Biology") and answers Rust with what the save
   * did. A project that vanished meanwhile is not an answer: the dialog asks
   * again, so it is handed back unanswered.
   */
  const saveCapture = useCallback(
    async (request: DesktopConversationRequest, workspaceId: string, project: string): Promise<CaptureSaveResult> => {
      const save = saveConversationRef.current
      const saved: CaptureSaveResult = save ? await save(workspaceId, request.conversation, request.truncated) : { ok: false, reason: "storage-failed" }
      if (!saved.ok && saved.reason === "project-missing") return saved
      answer(
        request.requestId,
        saved.ok
          ? { status: "done", project, saved: saved.outcome, turns: request.conversation.turns.length, truncated: request.truncated }
          : { status: "failed", added: 0, duplicates: 0, failed: 0 }
      )
      return saved
    },
    [answer]
  )
  useEffect(() => {
    if (!current) return
    const timer = setTimeout(() => {
      answeredRef.current.add(current.requestId)
      setQueue((pending) => pending.filter((request) => request.requestId !== current.requestId))
      log("request-expired", { requestId: current.requestId })
      onExpireRef.current?.(current)
    }, Math.max(0, current.expiresAt - Date.now() - EXPIRY_MARGIN_MS))
    return () => clearTimeout(timer)
  }, [current])

  return { current, waiting: queue.length, answer, saveCapture }
}
