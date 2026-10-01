"use client"

import { useSyncExternalStore } from "react"
import { isDesktop } from "@/lib/platform"

const subscribe = () => () => {}

/**
 * Whether this page is running inside Hubble Desktop, safe to read in render.
 *
 * `isDesktop()` must not be read during render (src/lib/platform/detect.ts):
 * a server or prerendered page has no webview and would hydrate against
 * different markup. Here the server snapshot is `false`, so hydration matches
 * the server, and React re-renders with the real answer straight after. A page
 * mounted on the client (the first-run landing inside the desktop app) gets
 * the real answer on its first render. The Tauri marker never changes while a
 * page is open, so there is nothing to subscribe to.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, isDesktop, () => false)
}
