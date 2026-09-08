"use client"

import { useEffect, useRef } from "react"
import type { BrowserImportEntry } from "@/lib/tabs/browser-import"
import { markExtensionConnected } from "@/lib/onboarding"
import {
  BROWSER_MESSAGE_SOURCE,
  MSG_TABDUMP_IMPORT,
  MSG_TABDUMP_IMPORT_ACK,
  MSG_TABDUMP_PAGE_READY,
} from "@/lib/browser/protocol"

// A real browser window realistically has well under this many tabs. This
// is defense-in-depth against a malformed or malicious message forcing a
// synchronous parse/categorize/render pass over an unbounded array — not a
// limit anyone doing the intended "dump my open tabs" workflow should ever
// approach. Truncates rather than rejects, matching /api/titles' own
// over-large-batch handling.
const MAX_IMPORT_TABS = 500

/** How many recent importIds to remember for the re-post dedupe below. */
const MAX_REMEMBERED_IMPORTS = 32

function isValidEntry(entry: unknown): entry is BrowserImportEntry {
  if (!entry || typeof entry !== "object") return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.url === "string" &&
    (e.title === undefined || typeof e.title === "string") &&
    (e.pinned === undefined || typeof e.pinned === "boolean")
  )
}

/**
 * Receives tab batches from the TabDump browser extension's content-script
 * bridge (see extension/content/content-script.js), which relays them via
 * `window.postMessage` after the extension's background worker opens or
 * reuses this page. Validates origin and message shape before trusting
 * anything — `postMessage` has no built-in sender authentication beyond the
 * origin check performed here.
 *
 * Two halves of a handshake make delivery ordering-independent, which is
 * what the extension's cross-machine dump failure came down to:
 *
 *  - `ready` says whether the app can actually take a batch right now
 *    (hydrated, workspace store loaded). The moment it can, this posts
 *    TABDUMP_PAGE_READY and the content script re-delivers anything it was
 *    holding. Without it, a payload arriving during hydration was posted
 *    into a document with no listener attached and lost outright — measured
 *    at 1–105ms of exposure on every single fresh page load, which is why
 *    reusing an already-open tab (a developer's own machine) worked while a
 *    freshly opened one (anyone else's) did not.
 *  - every batch the app takes is acked with the count it actually accepted,
 *    so the extension reports "imported 14" from evidence rather than
 *    assuming a message it managed to hand off must have been ingested.
 *
 * `onImport` returns how many tabs it accepted; that number is what gets
 * acked, so a batch the app silently drops can never be reported to the user
 * as a successful dump.
 */
export function useExtensionImport(
  onImport: (entries: BrowserImportEntry[]) => number,
  ready: boolean = true
) {
  const onImportRef = useRef(onImport)
  const readyRef = useRef(ready)
  // What each already-handled `importId` accepted. The content script
  // re-posts a batch whenever the page announces readiness, and readiness
  // can land while an ack for the same batch is still in flight — a re-post
  // must therefore re-ack (in case the first ack was the one that got lost)
  // without importing the same tabs a second time. Keyed by importId rather
  // than by content so a genuine second dump of the same tabs still counts.
  const handledRef = useRef(new Map<string, number>())
  // Deliberate "latest ref" idiom: these writes are same-render snapshot
  // assignments, not state mutations read back during this render, so they
  // can't cause the divergent-render bug the rule guards against.
  // eslint-disable-next-line react-hooks/refs
  onImportRef.current = onImport
  // eslint-disable-next-line react-hooks/refs
  readyRef.current = ready

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // The content script runs in this same document, so a same-origin,
      // same-window message is the only kind we ever expect — anything
      // else (a different origin, or a message relayed through an iframe)
      // is ignored outright rather than partially trusted.
      if (event.origin !== window.location.origin) return
      if (event.source !== window) return

      const data = event.data as
        | { source?: unknown; type?: unknown; payload?: { tabs?: unknown; importId?: unknown } }
        | null
      if (!data || data.source !== BROWSER_MESSAGE_SOURCE || data.type !== MSG_TABDUMP_IMPORT) return

      const importId = typeof data.payload?.importId === "string" ? data.payload.importId : undefined

      function ack(accepted: number) {
        // Acked even when nothing was accepted: the extension needs to hear
        // that this page handled the batch and came up with zero, which it
        // reports as a failure. Staying silent would instead look like the
        // page never being there at all, sending the dump into a pointless
        // retry in a second tab that would come up with the same zero.
        if (importId === undefined) return
        window.postMessage(
          { source: BROWSER_MESSAGE_SOURCE, type: MSG_TABDUMP_IMPORT_ACK, payload: { importId, accepted } },
          window.location.origin
        )
      }

      // A re-post of a batch already taken: answer again, import nothing.
      if (importId !== undefined && handledRef.current.has(importId)) {
        ack(handledRef.current.get(importId)!)
        return
      }

      // Not able to ingest yet. Deliberately no ack: the content script
      // holds the batch and re-posts it the moment the effect below
      // announces readiness, so declining here drops nothing.
      if (!readyRef.current) return

      const rawTabs = data.payload?.tabs
      if (!Array.isArray(rawTabs)) return

      const entries = rawTabs.filter(isValidEntry).slice(0, MAX_IMPORT_TABS)

      // The only honest "the extension is installed" signal available: a
      // real import actually landed. Recorded here, at the one place it's
      // genuinely true, rather than guessed anywhere else.
      markExtensionConnected()
      const accepted = entries.length === 0 ? 0 : onImportRef.current(entries) ?? 0

      if (importId !== undefined) {
        // One page can only ever see a handful of dumps, but this is a
        // long-lived tab: cap the ledger rather than letting it grow for the
        // life of the session.
        if (handledRef.current.size >= MAX_REMEMBERED_IMPORTS) {
          handledRef.current.delete(handledRef.current.keys().next().value!)
        }
        handledRef.current.set(importId, accepted)
      }
      ack(accepted)
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])

  useEffect(() => {
    if (!ready) return
    window.postMessage(
      { source: BROWSER_MESSAGE_SOURCE, type: MSG_TABDUMP_PAGE_READY, payload: {} },
      window.location.origin
    )
  }, [ready])
}
