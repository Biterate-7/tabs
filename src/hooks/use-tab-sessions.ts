"use client"

import { useEffect, useSyncExternalStore } from "react"
import { isBrowserConnected, startConnectionWatch, subscribeConnection } from "@/lib/browser/bridge"
import { getServerSessionsSnapshot, getSessionsSnapshot, subscribeSessions } from "@/lib/sessions/persistence"
import type { SessionsState } from "@/lib/sessions/types"

/**
 * The saved sessions, kept current: a change made on this page, or in another
 * Hubble tab (a session the extension saved into a background tab), renders
 * here without a reload. Reads only — writes go through writeSessions.
 */
export function useTabSessions(): SessionsState {
  return useSyncExternalStore(subscribeSessions, getSessionsSnapshot, getServerSessionsSnapshot)
}

/** Whether Hubble for Chrome is answering on this page. False until its first answer, and in Hubble Desktop. */
export function useBrowserConnected(): boolean {
  useEffect(() => startConnectionWatch(), [])
  return useSyncExternalStore(subscribeConnection, isBrowserConnected, () => false)
}
