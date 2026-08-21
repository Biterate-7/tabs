"use client"

import { useEffect, useRef } from "react"
import type { BrowserImportEntry } from "@/lib/tabs/browser-import"
import { markExtensionConnected } from "@/lib/onboarding"

const MESSAGE_SOURCE = "tabdump-extension"
const MESSAGE_TYPE = "TABDUMP_IMPORT"

// A real browser window realistically has well under this many tabs. This
// is defense-in-depth against a malformed or malicious message forcing a
// synchronous parse/categorize/render pass over an unbounded array — not a
// limit anyone doing the intended "dump my open tabs" workflow should ever
// approach. Truncates rather than rejects, matching /api/titles' own
// over-large-batch handling.
const MAX_IMPORT_TABS = 500

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
 * `window.postMessage` after the extension's background worker focuses or
 * opens this page. Validates origin and message shape before trusting
 * anything — `postMessage` has no built-in sender authentication beyond the
 * origin check performed here.
 */
export function useExtensionImport(onImport: (entries: BrowserImportEntry[]) => void) {
  const onImportRef = useRef(onImport)
  // Deliberate "latest ref" idiom: this write is a same-render snapshot
  // assignment, not a state mutation read back during this render, so it
  // can't cause the divergent-render bug the rule guards against.
  // eslint-disable-next-line react-hooks/refs
  onImportRef.current = onImport

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // The content script runs in this same document, so a same-origin,
      // same-window message is the only kind we ever expect — anything
      // else (a different origin, or a message relayed through an iframe)
      // is ignored outright rather than partially trusted.
      if (event.origin !== window.location.origin) return
      if (event.source !== window) return

      const data = event.data as { source?: unknown; type?: unknown; payload?: { tabs?: unknown } } | null
      if (!data || data.source !== MESSAGE_SOURCE || data.type !== MESSAGE_TYPE) return

      const rawTabs = data.payload?.tabs
      if (!Array.isArray(rawTabs)) return

      const entries = rawTabs.filter(isValidEntry).slice(0, MAX_IMPORT_TABS)
      if (entries.length === 0) return

      // The only honest "the extension is installed" signal available: a
      // real import actually landed. Recorded here, at the one place it's
      // genuinely true, rather than guessed anywhere else.
      markExtensionConnected()
      onImportRef.current(entries)
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])
}
