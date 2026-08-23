"use client"

import { useBrowserConnection } from "@/hooks/use-browser-connection"

/**
 * Small, static indicator of whether the TabDump Chrome extension is
 * currently reachable — see AGENTS.md section 5/16. Deliberately just a dot
 * + label, not a redesign of the panel: it slots into the existing header
 * next to the "Ask TabDump" title.
 */
export function BrowserConnectionIndicator() {
  const connected = useBrowserConnection()

  return (
    <span
      className="inline-flex items-center gap-1.5 text-meta text-tertiary"
      title={connected ? "The TabDump browser extension is connected." : "The TabDump browser extension isn't connected — browser actions aren't available."}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-tertiary/50"}`}
      />
      {connected ? "Browser connected" : "Browser unavailable"}
    </span>
  )
}
