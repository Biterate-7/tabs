"use client"

import { useEffect, useState } from "react"
import { isBrowserConnected, startConnectionWatch, subscribeConnection } from "@/lib/browser/bridge"

/**
 * Whether the TabDump Chrome extension is currently reachable from this
 * page — drives the "🟢 Browser connected" / "⚪ Browser control
 * unavailable" indicator (AGENTS.md section 5/16) and lets callers decide
 * whether to even attempt a browser action versus telling the user up front
 * that browser control isn't available.
 */
export function useBrowserConnection(): boolean {
  const [connected, setConnected] = useState(isBrowserConnected)

  useEffect(() => {
    const stopWatch = startConnectionWatch()
    const unsubscribe = subscribeConnection(setConnected)
    return () => {
      unsubscribe()
      stopWatch()
    }
  }, [])

  return connected
}
