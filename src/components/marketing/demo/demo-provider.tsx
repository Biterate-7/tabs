"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react"
import { isSafeOpenUrl } from "@/lib/browser/protocol"
import { restoreWorkspaceCollections } from "@/lib/collections/restore"
import type { AgentContextWorld } from "@/lib/agents/context/world"
import { workspaceIdOf } from "@/lib/agents/command-centre/working-context"
import {
  buildHandoffEnvelope,
  canHandOffFrom,
  readHandoffInstruction,
  selectHandoffContext,
} from "@/lib/agents/handoff/handoff"
import { prepareHandoffPreview } from "@/lib/agents/handoff/preview"
import { runtimeFailure } from "@/lib/agents/runtime/protocol"
import { buildSessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import { contextPackAttachedContext } from "@/lib/agents/context-pack/attach"
import { contextWorldOfSnapshot, handoffContextPack } from "@/lib/agents/context-pack/handoff"
import { contextDeliveryOf } from "@/lib/agents/context-pack/provenance"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { SessionHandoff } from "@/lib/agents/handoff/handoff"
import type { HandoffTransport } from "@/lib/agents/handoff/transport"
import type { RuntimeResult } from "@/lib/agents/runtime/protocol"
import type { ProjectWorkActions } from "@/components/agents/project-work"
import { checkRunningIn } from "@/lib/agents/project/changes"
import { DEMO_PROJECT_INSPECTION, demoProjectReview } from "./demo-project"
import { DEMO_NOW, DEMO_SESSION_PROVIDERS, handoffApproval } from "./data"
import {
  createDemoState,
  demoHandoffTarget,
  demoKnownApprovals,
  demoReducer,
  type DemoAction,
  type DemoInit,
  type DemoState,
} from "./demo-state"

/*
 * HubbleDemoProvider — the landing page's isolated demo state.
 *
 * One provider per demo window. It holds a DemoState (see demo-state.ts) and
 * the world the product's Context Pack is built from, and nothing else: it has no storage
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
  /** Sends a composer message and schedules the demo's reply. */
  send: (sessionId: string, text: string) => void
  /** Answers an approval; an approved change then plays out in the app's own steps. */
  respond: (approvalId: string, decision: "granted" | "denied") => void
  /** Undoes a recorded change exactly. `false` when it could not be, and nothing moved. */
  undo: (changeId: string) => boolean
  /** Undoes a past session's change exactly, as `undo` does a live one. */
  undoHistory: (sessionId: string, changeId: string) => boolean
  /**
   * A session's project actions (Hubble 1.6) — the deterministic adapter
   * behind the product's own ProjectWorkActions: undo, review and checks.
   */
  projectWork: (sessionId: string) => ProjectWorkActions
  /** Opens a saved tab's page in a new browser tab. Never navigates the landing page itself. */
  openUrl: (url: string) => void
  /**
   * The handoff dialog's transport for one session (Hubble 1.4):
   * the runtime's two steps played deterministically on this page — the
   * same preview, envelope and record functions, no network.
   */
  handoff: (sourceSessionId: string) => HandoffTransport
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

  const undoHistory = useCallback(
    (sessionId: string, changeId: string) => {
      const detail = state.history.find((entry) => entry.session.sessionId === sessionId)
      const change = detail?.records.changes.find((candidate) => candidate.id === changeId)
      if (!detail || !change || !change.ok || !change.before || !change.after) return false
      if (detail.records.undos.some((undo) => undo.changeId === changeId)) return false
      if (!restoreWorkspaceCollections(state.collections, change.workspaceId, change.before, change.after)) return false
      dispatch({ type: "undo-history", sessionId, changeId })
      return true
    },
    [state.history, state.collections]
  )

  /*
    The demo's handoff transport. Reads the state at the moment it is asked,
    as the runtime reads its own records — the latest, not the render's.
  */
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const handoff = useCallback((sourceSessionId: string): HandoffTransport => {
    /** What the runtime would check and preview, from the demo's records. */
    const candidate = (target: AgentProviderId) => {
      const current = stateRef.current
      const entry = current.sessions.find((session) => session.view.sessionId === sourceSessionId)
      if (!entry) return runtimeFailure<never>("session_not_found")
      const workspaceId = workspaceIdOf(entry.view)
      if (!workspaceId || !canHandOffFrom(entry.view.status)) return runtimeFailure<never>("invalid_session_state")
      if (!DEMO_SESSION_PROVIDERS.has(target)) return runtimeFailure<never>("provider_unavailable")
      const snapshot = buildSessionContextSnapshot(
        { workspaces: current.store.workspaces, collections: current.collections, dependencies: current.dependencies },
        workspaceId
      )
      const prepared = prepareHandoffPreview({
        session: entry.view,
        workspaceId,
        events: current.events[sourceSessionId] ?? [],
        knownApprovals: demoKnownApprovals(current),
        changes: current.changes.filter((change) => change.sessionId === sourceSessionId),
        ...(snapshot ? { snapshot } : {}),
        ...(entry.view.focus ? { focus: entry.view.focus } : {}),
        targetProvider: target,
        contextTools: true,
        now: DEMO_NOW,
      })
      return {
        ok: true as const,
        value: { ...prepared, source: entry.view, snapshot, workspaceName: snapshot?.workspace.name ?? "", count: current.handoffs.length },
      }
    }

    return {
      prepare: async (target) => {
        const found = candidate(target)
        return found.ok ? { ok: true, value: found.value.preview } : found
      },
      start: async ({ preview, include, instruction }): Promise<RuntimeResult<{ handoff: SessionHandoff; session: ReturnType<typeof demoHandoffTarget> }>> => {
        const found = candidate(preview.targetProvider)
        if (!found.ok) return found
        // What the visitor saw is what is sent, or nothing is — as in Hubble.
        if (found.value.preview.fingerprint !== preview.fingerprint) return runtimeFailure("context_invalid")
        const { source, workspaceName, snapshot, focus } = found.value
        const n = found.value.count + 1
        const said = readHandoffInstruction(instruction)
        const record: SessionHandoff = {
          handoffId: `demo-handoff-${n}`,
          workspaceId: preview.workspaceId,
          sourceSessionId,
          sourceProvider: source.provider,
          targetProvider: preview.targetProvider,
          targetSessionId: `session-handoff-${n}`,
          status: "ready",
          context: selectHandoffContext(found.value.preview.context, include),
          ...(said ? { instruction: said } : {}),
          createdAt: DEMO_NOW,
          updatedAt: DEMO_NOW,
        }
        // The canonical Context Pack, built as the runtime builds it: from the
        // source's workspace copy and focus, with the modes the visitor kept.
        const pack =
          record.context.workspace && snapshot
            ? handoffContextPack({
                world: contextWorldOfSnapshot(snapshot),
                workspaceId: preview.workspaceId,
                ...(focus ? { focus } : {}),
                context: record.context,
                ...(said ? { instruction: said } : {}),
              })
            : undefined
        const packed = pack ? contextPackAttachedContext(pack, DEMO_NOW) : null
        const envelope = buildHandoffEnvelope({
          workspaceName,
          sourceProvider: source.provider,
          ...(source.title ? { sourceTitle: source.title } : {}),
          context: record.context,
          contextTools: true,
          ...(said ? { instruction: said } : {}),
          ...(pack && packed ? { pack } : {}),
        })
        const delivery = packed ? contextDeliveryOf(packed, preview.workspaceId) : undefined
        dispatch({
          type: "handoff-start",
          handoff: record,
          envelope,
          ...(source.title ? { title: source.title } : {}),
          workspaceName,
          ...(packed ? { pack: { contextId: packed.snapshotId, ...(delivery ? { delivery } : {}), ...(focus ? { focus } : {}) } } : {}),
        })
        // The new agent reads the workspace, then asks before changing it.
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          dispatch({
            type: "handoff-work",
            sessionId: record.targetSessionId!,
            approval: handoffApproval(record.targetSessionId!, `approval-handoff-${n}`, DEMO_NOW),
          })
        }, DEMO_STEP_DELAY_MS * 3)
        timers.current.add(timer)
        return { ok: true, value: { handoff: record, session: demoHandoffTarget(record, source.title, workspaceName) } }
      },
    }
  }, [])

  const openUrl = useCallback((url: string) => {
    if (!isSafeOpenUrl(url)) return
    // Hubble's own demo pages live on a reserved domain that resolves nowhere.
    if (new URL(url).hostname.endsWith(".example")) return
    window.open(url, "_blank", "noopener,noreferrer")
  }, [])

  const projectWork = useCallback(
    (sessionId: string): ProjectWorkActions => {
      const events = state.events[sessionId] ?? []
      return {
        undo: async (changeId) => {
          const change = events.find((event) => event.projectChange?.changeId === changeId)?.projectChange
          if (!change) return null
          dispatch({ type: "project-undo", sessionId, changeId })
          return { outcome: "undone", files: change.files.filter((file) => file.change !== "unchanged").length }
        },
        review: async (changeId) => {
          const edit = state.projectEdits[changeId]
          return edit ? demoProjectReview(edit) : null
        },
        checks: DEMO_PROJECT_INSPECTION.checks,
        runCheck: async (check) => {
          if (checkRunningIn(events)) return false
          const checkId = `demo-check-${sessionId}-${events.length}`
          dispatch({ type: "project-check", sessionId, checkId, check, phase: "started" })
          const timer = setTimeout(() => {
            timers.current.delete(timer)
            dispatch({ type: "project-check", sessionId, checkId, check, phase: "finished" })
          }, DEMO_STEP_DELAY_MS * 2)
          timers.current.add(timer)
          return true
        },
        checking: checkRunningIn(events),
      }
    },
    [state.events, state.projectEdits]
  )

  const value = useMemo<DemoContextValue>(
    () => ({ state, dispatch, world, send, respond, undo, undoHistory, projectWork, openUrl, handoff, ...(scheme ? { scheme } : {}) }),
    [state, world, send, respond, undo, undoHistory, projectWork, openUrl, handoff, scheme]
  )

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}

export function useHubbleDemo(): DemoContextValue {
  const value = useContext(DemoContext)
  if (!value) throw new Error("useHubbleDemo must be used inside HubbleDemoProvider")
  return value
}
