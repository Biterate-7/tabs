"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { readDesktopImportRequest, type DesktopImportOutcome, type DesktopImportRequest } from "@/lib/desktop/import-protocol"

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
 * Chrome → Hubble Desktop, in the webview: the batches the extension sent,
 * oldest first, for the import dialog to put in front of the person.
 *
 * Batches wait in Rust, not here, so nothing is lost while this window
 * starts: the moment `ready` (the store is loaded and can take an import),
 * this asks Rust for everything waiting — including a batch that arrived
 * while Hubble was still launching — and asks again whenever Rust says a new
 * one came in. A batch is answered exactly once (`answer`), and only then
 * leaves the queue.
 *
 * `bridge` is undefined on the web, where there is no desktop import.
 */
export function useDesktopImport(bridge: DesktopImportBridge | undefined, ready: boolean, onExpire?: (request: DesktopImportRequest) => void) {
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
        const request = readDesktopImportRequest(entry, now)
        if (!request || answeredRef.current.has(request.requestId)) continue
        // Nothing usable in it: answer at once rather than show an empty choice.
        if (request.tabs.length === 0) {
          answeredRef.current.add(request.requestId)
          void bridge!.finish(request.requestId, { status: "failed", added: 0, duplicates: 0, failed: request.received }).catch(() => undefined)
          continue
        }
        fresh.push(request)
      }
      if (fresh.length === 0) return
      log("requests-received", { requestIds: fresh.map((request) => request.requestId), tabs: fresh.map((request) => request.tabs.length) })
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
      log("request-answered", { requestId, status: outcome.status, added: outcome.added, duplicates: outcome.duplicates, failed: outcome.failed })
      // Refused only if Rust has let it go already (the margin below makes that the rare case).
      void bridge?.finish(requestId, outcome).catch((err) => log("finish-failed", { requestId, detail: err instanceof Error ? err.message : String(err) }))
    },
    [bridge]
  )

  // A batch Rust has stopped waiting for can no longer be answered: adding it
  // here would put tabs in a project while Chrome says nothing was added. It
  // leaves the queue when Rust lets it go.
  const current = queue[0]
  const onExpireRef = useRef(onExpire)
  useEffect(() => {
    onExpireRef.current = onExpire
  })
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

  return { current, waiting: queue.length, answer }
}
