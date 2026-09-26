"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react"
import { useAgentContext, type AgentContextApi } from "@/hooks/use-agent-context"
import { isSafeOpenUrl } from "@/lib/browser/protocol"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import { DEMO_NOW } from "./data"
import { createDemoState, demoReducer, type DemoAction, type DemoInit, type DemoState } from "./demo-state"

/*
 * HubbleDemoProvider — the landing page's isolated demo state.
 *
 * One provider per demo window. It holds a DemoState (see demo-state.ts) and
 * the Command Centre's context selection, and nothing else: it has no storage
 * key, opens no connection, starts no runtime and reads no filesystem. The
 * app's own stores are never imported here, so no interaction on the landing
 * page can reach a visitor's real Hubble data, even when the page is shown as
 * the first-run state of `/` inside AppShell.
 */

export type DemoScheme = "system" | "light" | "dark"

type DemoContextValue = {
  state: DemoState
  dispatch: Dispatch<DemoAction>
  /** What the context resolver may see: the demo's workspaces and collections, and nothing of the visitor's. */
  world: AgentContextWorld
  /** The Command Centre's context selection and attached snapshot — the product's own hook, fed the demo world. */
  context: AgentContextApi
  /** Sends a composer message and schedules the demo's reply. */
  send: (sessionId: string, text: string) => void
  /** Opens a saved tab's page in a new browser tab. Never navigates the landing page itself. */
  openUrl: (url: string) => void
  scheme?: { value: DemoScheme; set: (scheme: DemoScheme) => void }
}

const DemoContext = createContext<DemoContextValue | null>(null)

/** How long the demo waits before replying — long enough to read the message landing, short enough not to feel staged. */
export const DEMO_REPLY_DELAY_MS = 700

export function HubbleDemoProvider({
  init,
  scheme,
  children,
}: {
  init?: DemoInit
  scheme?: DemoContextValue["scheme"]
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(demoReducer, init, createDemoState)

  const world = useMemo<AgentContextWorld>(
    () => ({
      ownerId: null,
      workspaces: state.store.workspaces,
      collections: state.collections,
      dependencies: state.dependencies,
      manualConnections: [],
      projects: [],
      agents: [],
      runs: [],
    }),
    [state.store.workspaces, state.collections, state.dependencies]
  )

  // Deterministic snapshot ids and capture times, so a snapshot attached in
  // the demo reads the same on every visit.
  const snapshotCounter = useRef(0)
  const now = useCallback(() => DEMO_NOW, [])
  const createSnapshotId = useCallback(() => {
    snapshotCounter.current += 1
    return `demo-snapshot-${snapshotCounter.current}`
  }, [])
  const context = useAgentContext({ world, localRuntimeAllowed: false, now, createSnapshotId })

  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const send = useCallback((sessionId: string, text: string) => {
    if (!text.trim()) return
    dispatch({ type: "send", sessionId, text })
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      dispatch({ type: "reply", sessionId })
    }, DEMO_REPLY_DELAY_MS)
    timers.current.add(timer)
  }, [])

  const openUrl = useCallback((url: string) => {
    if (!isSafeOpenUrl(url)) return
    // Hubble's own demo pages live on a reserved domain that resolves nowhere.
    if (new URL(url).hostname.endsWith(".example")) return
    window.open(url, "_blank", "noopener,noreferrer")
  }, [])

  const value = useMemo<DemoContextValue>(
    () => ({ state, dispatch, world, context, send, openUrl, ...(scheme ? { scheme } : {}) }),
    [state, world, context, send, openUrl, scheme]
  )

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}

export function useHubbleDemo(): DemoContextValue {
  const value = useContext(DemoContext)
  if (!value) throw new Error("useHubbleDemo must be used inside HubbleDemoProvider")
  return value
}
