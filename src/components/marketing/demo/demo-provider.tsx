"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react"
import { useAgentContext, type AgentContextApi } from "@/hooks/use-agent-context"
import { isSafeOpenUrl } from "@/lib/browser/protocol"
import { restoreWorkspaceCollections } from "@/lib/collections/restore"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import { DEMO_NOW } from "./data"
import { createDemoState, demoReducer, type DemoAction, type DemoInit, type DemoState } from "./demo-state"

/*
 * HubbleDemoProvider — the landing page's isolated demo state.
 *
 * One provider per demo window. It holds a DemoState (see demo-state.ts) and
 * the product's context resolver, and nothing else: it has no storage
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
  /** The product's own context resolver, fed the demo world: what a session is told, resolved for real. */
  context: AgentContextApi
  /** Sends a composer message and schedules the demo's reply. */
  send: (sessionId: string, text: string) => void
  /** Answers an approval; an approved change then plays out in the app's own steps. */
  respond: (approvalId: string, decision: "granted" | "denied") => void
  /** Undoes a recorded change exactly. `false` when it could not be, and nothing moved. */
  undo: (changeId: string) => boolean
  /** Opens a saved tab's page in a new browser tab. Never navigates the landing page itself. */
  openUrl: (url: string) => void
  scheme?: { value: DemoScheme; set: (scheme: DemoScheme) => void }
}

const DemoContext = createContext<DemoContextValue | null>(null)

/** How long the demo waits before replying — long enough to read the message landing, short enough not to feel staged. */
export const DEMO_REPLY_DELAY_MS = 700

/**
 * The pause between the steps of an approved change — approved, applied,
 * answered — so each state the app passes through is on screen long enough
 * to see. The states and their order are the app's; only the pacing is set.
 */
export const DEMO_STEP_DELAY_MS = 450

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

  const respond = useCallback(
    (approvalId: string, decision: "granted" | "denied") => {
      dispatch({ type: "respond", approvalId, decision })
      if (decision !== "granted") return
      const steps: DemoAction[] = [
        { type: "apply-approved", approvalId },
        { type: "finish-approved", approvalId },
      ]
      steps.forEach((step, index) => {
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          dispatch(step)
        }, DEMO_STEP_DELAY_MS * (index + 1))
        timers.current.add(timer)
      })
    },
    []
  )

  // Decided against the state on screen, so the answer is known before the
  // reducer runs — the same check the reducer makes, through the same restore.
  const undo = useCallback(
    (changeId: string) => {
      const change = state.changes.find((candidate) => candidate.id === changeId)
      if (!change || !change.ok || change.undone || !change.before || !change.after) return false
      if (!restoreWorkspaceCollections(state.collections, change.workspaceId, change.before, change.after)) return false
      dispatch({ type: "undo", changeId })
      return true
    },
    [state.changes, state.collections]
  )

  const openUrl = useCallback((url: string) => {
    if (!isSafeOpenUrl(url)) return
    // Hubble's own demo pages live on a reserved domain that resolves nowhere.
    if (new URL(url).hostname.endsWith(".example")) return
    window.open(url, "_blank", "noopener,noreferrer")
  }, [])

  const value = useMemo<DemoContextValue>(
    () => ({ state, dispatch, world, context, send, respond, undo, openUrl, ...(scheme ? { scheme } : {}) }),
    [state, world, context, send, respond, undo, openUrl, scheme]
  )

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}

export function useHubbleDemo(): DemoContextValue {
  const value = useContext(DemoContext)
  if (!value) throw new Error("useHubbleDemo must be used inside HubbleDemoProvider")
  return value
}
