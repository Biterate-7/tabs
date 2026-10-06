"use client"

import { useEffect, useRef } from "react"
import { normalizeUrl } from "@/lib/tabs/normalize"
import type { Tab } from "@/lib/tabs/types"

const MESSAGE_SOURCE = "tabdump-extension"
const REQUEST_TYPE = "TABDUMP_CHECK_IMPORTED"
const RESULT_TYPE = "TABDUMP_CHECK_IMPORTED_RESULT"

function tryNormalize(url: string): string | null {
  try {
    return normalizeUrl(new URL(url));
  } catch {
    return null;
  }
}

/**
 * Answers the extension popup's "which of these tabs are already in the
 * currently selected workspace?" query (see extension/content/content-script.js
 * and extension/background/background.js for the other legs of this round
 * trip), so the popup can show "31 new · 16 already imported" instead of a
 * plain count and avoid re-dumping tabs that are already here.
 *
 * Reuses the exact same `normalizeUrl` the workspace's own duplicate
 * detection uses (see lib/tabs/duplicates.ts) — there is no second,
 * extension-side notion of "duplicate." If no Hubble tab is open at all,
 * this listener simply never gets attached to answer anything, and the
 * extension falls back to its plain "N tabs detected" wording.
 *
 * `tabs` is tracked via a ref rather than a `useEffect` dependency so the
 * global `message` listener is only ever attached once, matching the same
 * pattern `useExtensionImport` uses.
 */
/** A project as the extension popup may list it (Hubble 2.0): an id, a name and how many sources it holds. Nothing else. */
export type ExtensionProjectOption = { id: string; name: string; sources: number }

export function useExtensionWorkspaceQuery(tabs: Tab[], projects: readonly ExtensionProjectOption[] = []) {
  const tabsRef = useRef(tabs)
  const projectsRef = useRef(projects)
  // eslint-disable-next-line react-hooks/refs
  tabsRef.current = tabs
  // eslint-disable-next-line react-hooks/refs
  projectsRef.current = projects

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.source !== window) return

      const data = event.data as
        | { source?: unknown; type?: unknown; payload?: { requestId?: unknown; urls?: unknown } }
        | null
      if (!data || data.source !== MESSAGE_SOURCE || data.type !== REQUEST_TYPE) return

      const requestId = data.payload?.requestId
      const urls = data.payload?.urls
      if (typeof requestId !== "string" || !Array.isArray(urls)) return

      const existingNormalized = new Set(tabsRef.current.map((t) => t.normalizedUrl))
      const existingUrls = urls.filter((url): url is string => {
        if (typeof url !== "string") return false
        const normalized = tryNormalize(url)
        return normalized !== null && existingNormalized.has(normalized)
      })

      window.postMessage(
        { source: MESSAGE_SOURCE, type: RESULT_TYPE, payload: { requestId, existingUrls, ...(projectsRef.current.length > 0 ? { projects: projectsRef.current } : {}) } },
        window.location.origin
      )
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])
}
