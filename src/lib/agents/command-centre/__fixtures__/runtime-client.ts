import { runtimeFailure } from "@/lib/agents/runtime/protocol"
import { reviveHistoryChange } from "@/lib/agents/activity/history"
import type { AgentHistoryStore } from "@/lib/agents/activity/history-store"
import { snapshotFingerprint } from "@/lib/agents/session-context/snapshot"
import { attachmentsStayIn, focusFitsSnapshot, focusFromAttachments, isEmptyFocus } from "@/lib/agents/session-context/focus"
import type { AgentAttachedContext } from "@/lib/agents/control/context"
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type {
  ProviderConnectionView,
  ProviderDetection,
} from "@/lib/agents/runtime/protocol"
import type {
  RuntimeApprovalView,
  RuntimeCommand,
  RuntimeCommandName,
  RuntimeCommandResult,
  RuntimeCorrelationView,
  RuntimeErrorCode,
  RuntimeSessionView,
  RuntimeStatus,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol"

/**
 * A runtime client the tests drive by hand.
 *
 * ## Why a fake client rather than a fake `fetch`
 *
 * `RuntimeClient` is the seam the UI is built against, and it is the *only*
 * thing the command centre can reach. Substituting at that boundary tests
 * exactly what ships: every command the surface issues goes through this
 * object, so a component that tried to reach anything else would fail to do
 * anything at all rather than quietly succeeding against a stub.
 *
 * It also keeps the tests honest about the contract's shape — every reply here
 * is a real `RuntimeResult`, including the failures, so a UI path that forgot
 * to handle `{ ok: false }` breaks here rather than in a browser.
 */

export type ScriptedRuntime = {
  client: RuntimeClient
  /** Every command the UI issued, in order. The assertion surface for "what did it send". */
  readonly commands: readonly RuntimeCommand[]
  /** Replaces the status the next `get_status` answers with. */
  setStatus: (status: RuntimeStatus) => void
  setSessions: (sessions: readonly RuntimeSessionView[]) => void
  setCorrelations: (correlations: readonly RuntimeCorrelationView[]) => void
  setApprovals: (approvals: readonly RuntimeApprovalView[]) => void
  /** Appends events the next `get_events` will deliver, assigning sequences. */
  pushEvents: (events: readonly Omit<SequencedControlEvent, "sequence">[]) => void
  /** Makes the named command fail with this code until cleared. */
  failCommand: (name: RuntimeCommandName, code: RuntimeErrorCode) => void
  clearFailure: (name: RuntimeCommandName) => void
  /** What `detect_providers` reports is installed (Phase J). */
  setDetections: (detections: readonly ProviderDetection[]) => void
  /** What `connect_provider` answers for a provider; sign-in flips it to authenticated. */
  setConnection: (view: ProviderConnectionView) => void
}

/** The actor a scripted runtime answers history for — the local actor, as on a Hubble with no accounts. */
export const FIXTURE_HISTORY_OWNER = "local"

export const FIXTURE_RUNTIME_ID = "runtime-fixture"

export function scriptedStatus(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    environment: "local",
    executable: true,
    runtimeId: FIXTURE_RUNTIME_ID,
    providers: [
      {
        provider: "claude-code",
        connection: "connected",
        available: true,
        authentication: "unknown",
        capabilities: ["create_session", "message", "cancel_run", "stream_events"],
      },
    ],
    ...over,
  }
}

export function scriptedSession(over: Partial<RuntimeSessionView> = {}): RuntimeSessionView {
  return {
    sessionId: "session-1",
    provider: "claude-code",
    status: "ready",
    runIds: [],
    awaitingApproval: false,
    cancellable: false,
    resumable: false,
    latestSequence: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

export function createScriptedRuntime(
  initial: {
    status?: RuntimeStatus
    sessions?: readonly RuntimeSessionView[]
    /**
     * Agent history, answered as the host answers it — owner- and
     * workspace-scoped through the store. Absent: `history_unavailable`, as a
     * host with no database says.
     */
    history?: AgentHistoryStore
  } = {}
): ScriptedRuntime {
  const history = initial.history
  let status = initial.status ?? scriptedStatus()
  let sessions = initial.sessions ?? []
  let correlations: readonly RuntimeCorrelationView[] = []
  let approvals: readonly RuntimeApprovalView[] = []
  let events: SequencedControlEvent[] = []

  const commands: RuntimeCommand[] = []
  const failures = new Map<RuntimeCommandName, RuntimeErrorCode>()
  let detections: readonly ProviderDetection[] = []
  const connectionViews = new Map<AgentProviderId, ProviderConnectionView>()

  let runtimeId: string | undefined
  /** The snapshot each session was started with — what the host would check a focus against. */
  const snapshots = new Map<string, SessionContextSnapshot>()

  /**
   * Context attached to a session, recorded as the host records it: its tab
   * and collection references become the session's focus, not yet delivered.
   * Refused, exactly as the host refuses it, when it reaches outside the
   * session's workspace.
   */
  function withFocus(view: RuntimeSessionView, context: AgentAttachedContext): RuntimeSessionView | undefined {
    const workspaceId = view.context?.workspaceId ?? view.workspaceId
    const focus = focusFromAttachments(context.attachments)
    if (workspaceId && !attachmentsStayIn(context.attachments, workspaceId)) return undefined
    const snapshot = snapshots.get(view.sessionId)
    if (workspaceId && snapshot && !focusFitsSnapshot(snapshot, focus)) return undefined
    const { focus: _previous, ...rest } = view
    void _previous
    return {
      ...rest,
      contextSnapshotId: context.snapshotId,
      ...(isEmptyFocus(focus) ? {} : { focus: { tabIds: [...focus.tabIds], collectionIds: [...focus.collectionIds], delivered: false } }),
    }
  }

  /**
   * The reply, computed over the non-generic union.
   *
   * Kept separate from `send` because a `switch` on `command.name` narrows a
   * plain `RuntimeCommand` and cannot narrow `Extract<RuntimeCommand, {name: N}>`
   * while `N` is still a type parameter. Doing the work here and casting once
   * at the boundary keeps every branch below genuinely type-checked against the
   * real command shapes.
   */
  function reply(command: RuntimeCommand): unknown {
    const failure = failures.get(command.name)
    if (failure) return runtimeFailure<never>(failure)

    switch (command.name) {
      case "get_status":
        runtimeId = status.runtimeId
        return { ok: true, value: status }

      case "list_sessions":
        return { ok: true, value: { sessions, correlations } }

      case "get_session": {
        const found = sessions.find((s) => s.sessionId === command.sessionId)
        if (!found) return runtimeFailure<never>("session_not_found")
        return { ok: true, value: { session: found, approvals } }
      }

      case "get_events": {
        const after = "afterSequence" in command ? (command.afterSequence ?? 0) : 0
        const slice = events.filter((event) => event.sequence > after)
        return {
          ok: true,
          value: {
            events: slice,
            latestSequence: events.length > 0 ? events[events.length - 1]!.sequence : after,
          },
        }
      }

      case "authorize_projects":
        return {
          ok: true,
          value: { accepted: command.projects.map((p) => p.id), rejected: [] },
        }

      case "create_session": {
        const created = scriptedSession({
          sessionId: `session-${sessions.length + 1}`,
          provider: command.provider,
          ...(command.projectId ? { projectId: command.projectId } : {}),
          ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
          ...(command.title ? { title: command.title } : {}),
          // Phase J.3: like the host, a session started with its workspace
          // gets that workspace's context — read-only here; tests that need
          // more script the session directly.
          ...(command.contextSnapshot
            ? {
                context: {
                  workspaceId: command.contextSnapshot.workspace.id,
                  workspaceName: command.contextSnapshot.workspace.name,
                  capabilities: ["workspace.read", "tabs.read", "collections.read", "relationships.read"] as const,
                  version: 1,
                  syncedAt: 1_700_000_000_000,
                  fingerprint: snapshotFingerprint(command.contextSnapshot),
                  pendingActions: [],
                },
              }
            : {}),
        })
        if (command.contextSnapshot) snapshots.set(created.sessionId, command.contextSnapshot)
        const started = command.context ? withFocus(created, command.context) : created
        if (!started) {
          snapshots.delete(created.sessionId)
          return runtimeFailure<never>("context_invalid")
        }
        sessions = [...sessions, started]
        return { ok: true, value: started }
      }

      case "attach_context": {
        const target = sessions.find((s) => s.sessionId === command.sessionId)
        if (!target) return runtimeFailure<never>("session_not_found")
        const next = withFocus(target, command.context)
        if (!next) return runtimeFailure<never>("context_invalid")
        sessions = sessions.map((s) => (s.sessionId === target.sessionId ? next : s))
        return { ok: true, value: next }
      }

      case "detach_context": {
        const target = sessions.find((s) => s.sessionId === command.sessionId)
        if (!target) return runtimeFailure<never>("session_not_found")
        const { focus: _focus, contextSnapshotId: _snapshot, ...rest } = target
        void _focus
        void _snapshot
        sessions = sessions.map((s) => (s.sessionId === target.sessionId ? rest : s))
        return { ok: true, value: rest }
      }

      case "send_message": {
        const target = sessions.find((s) => s.sessionId === command.sessionId)
        if (!target) return runtimeFailure<never>("session_not_found")
        // Attached context goes with this message, once.
        const sent = target.focus ? { ...target, focus: { ...target.focus, delivered: true } } : target
        sessions = sessions.map((s) => (s.sessionId === target.sessionId ? sent : s))
        return { ok: true, value: sent }
      }

      /* Phase J.3 — session workspace context. */
      case "sync_session_context": {
        const existing = sessions.find((s) => s.sessionId === command.sessionId)
        if (!existing) return runtimeFailure<never>("session_not_found")
        // Like the host: the same workspace only, and the version moves only
        // when the content does.
        const context = existing.context
        if (!context || command.snapshot.workspace.id !== context.workspaceId) return runtimeFailure<never>("context_invalid")
        const fingerprint = snapshotFingerprint(command.snapshot)
        const version = fingerprint === context.fingerprint ? context.version : context.version + 1
        sessions = sessions.map((s) =>
          s.sessionId === command.sessionId ? { ...s, context: { ...context, fingerprint, version } } : s
        )
        return { ok: true, value: { sessionId: command.sessionId, version } }
      }

      case "complete_context_action": {
        if (!sessions.some((s) => s.sessionId === command.sessionId)) return runtimeFailure<never>("session_not_found")
        return { ok: true, value: { sessionId: command.sessionId } }
      }

      case "dispose_session":
        sessions = sessions.filter((s) => s.sessionId !== command.sessionId)
        return { ok: true, value: { sessionId: command.sessionId } }

      case "cancel_run":
      case "respond_to_approval":
      case "resume_session": {
        const target =
          "sessionId" in command
            ? sessions.find((s) => s.sessionId === command.sessionId)
            : sessions[0]
        if (!target) return runtimeFailure<never>("session_not_found")
        return { ok: true, value: target }
      }

      case "link_observation":
        return runtimeFailure<never>("unsupported")

      /* Phase J — the connector lifecycle. */
      case "detect_providers":
        return { ok: true, value: { thisMachine: status.environment === "local", detections } }

      case "connect_provider":
      case "authenticate_provider":
      case "disconnect_provider": {
        // Like the host: a provider it reports on answers with its status
        // (no sign-in methods of its own); only one it has no adapter for is
        // `provider_unavailable`.
        const reported = status.providers.find((entry) => entry.provider === command.provider)
        const view = connectionViews.get(command.provider) ?? (reported ? { ...reported, authMethods: [] } : undefined)
        if (!view) return runtimeFailure<never>("provider_unavailable")
        if (command.name === "authenticate_provider") {
          const signedIn = {
            ...view,
            connection: "connected" as const,
            authentication: "authenticated" as const,
          }
          connectionViews.set(command.provider, signedIn)
          return { ok: true, value: signedIn }
        }
        if (command.name === "disconnect_provider") {
          return { ok: true, value: { ...view, connection: "disconnected" as const } }
        }
        return { ok: true, value: view }
      }

      case "list_history":
        if (!history) return runtimeFailure<never>("history_unavailable")
        return history
          .listSessions(FIXTURE_HISTORY_OWNER, command.workspaceId, {
            ...(command.before ? { before: command.before } : {}),
            ...(command.limit ? { limit: command.limit } : {}),
          })
          .then((value) => ({ ok: true, value }))

      case "get_history":
        if (!history) return runtimeFailure<never>("history_unavailable")
        return history
          .readSession(FIXTURE_HISTORY_OWNER, command.workspaceId, command.sessionId)
          .then((value) => (value ? { ok: true, value } : runtimeFailure<never>("session_not_found")))

      case "record_workspace_change": {
        if (!history) return runtimeFailure<never>("history_unavailable")
        const target = sessions.find((s) => s.sessionId === command.sessionId)
        const workspaceId = target?.workspaceId ?? target?.context?.workspaceId
        if (!target || !workspaceId) return runtimeFailure<never>("session_not_found")
        const approvalId = target.context?.pendingActions.find((action) => action.actionId === command.change.id)?.approvalId
        const change = reviveHistoryChange(
          { ...command.change, sessionId: target.sessionId, provider: target.provider, workspaceId, ...(approvalId ? { approvalId } : {}) },
          { sessionId: target.sessionId, workspaceId }
        )
        if (!change) return runtimeFailure<never>("invalid_request")
        return history
          .write(FIXTURE_HISTORY_OWNER, {
            sessions: [
              {
                sessionId: target.sessionId,
                workspaceId,
                provider: target.provider,
                status: target.status,
                startedAt: target.createdAt,
                lastActivityAt: Math.max(target.updatedAt, change.at),
                ...(target.title ? { title: target.title } : {}),
              },
            ],
            records: [{ sessionId: target.sessionId, kind: "change", key: change.id, at: change.at, data: change }],
          })
          .then(() => ({ ok: true, value: { sessionId: target.sessionId } }))
      }

      case "record_workspace_undo": {
        if (!history) return runtimeFailure<never>("history_unavailable")
        const { workspaceId, sessionId, changeId, at } = command
        return history.hasAppliedChange(FIXTURE_HISTORY_OWNER, workspaceId, sessionId, changeId).then(async (known) => {
          if (!known) return runtimeFailure<never>("session_not_found")
          await history.write(FIXTURE_HISTORY_OWNER, {
            sessions: [],
            records: [{ sessionId, kind: "undo", key: changeId, at, data: { changeId, at } }],
          })
          return { ok: true, value: { sessionId, changeId } }
        })
      }

      default:
        return runtimeFailure<never>("invalid_request")
    }
  }

  async function send<N extends RuntimeCommandName>(
    command: Extract<RuntimeCommand, { name: N }>
  ): Promise<RuntimeCommandResult<N>> {
    commands.push(command)
    return reply(command) as RuntimeCommandResult<N>
  }

  return {
    client: {
      runtimeId: () => runtimeId,
      send,
      status: () => send({ name: "get_status" }),
      reset: () => {
        runtimeId = undefined
      },
    },
    commands,
    setStatus: (next) => {
      status = next
    },
    setSessions: (next) => {
      sessions = next
    },
    setCorrelations: (next) => {
      correlations = next
    },
    setApprovals: (next) => {
      approvals = next
    },
    pushEvents: (next) => {
      for (const event of next) {
        events = [...events, { ...event, sequence: events.length + 1 }]
      }
    },
    failCommand: (name, code) => failures.set(name, code),
    clearFailure: (name) => failures.delete(name),
    setDetections: (next) => {
      detections = next
    },
    setConnection: (view) => {
      connectionViews.set(view.provider, view)
    },
  }
}

/** One normalized event, with the fields the stream reads. */
export function scriptedEvent(
  over: Partial<Omit<SequencedControlEvent, "sequence">> = {}
): Omit<SequencedControlEvent, "sequence"> {
  return {
    id: `event-${Math.random().toString(36).slice(2)}`,
    sessionId: "session-1",
    provider: "claude-code",
    kind: "message_received",
    timestamp: 1_700_000_000_000,
    summary: "An event",
    ...over,
  }
}

/**
 * An approval that is still open.
 *
 * `expiresAt` is relative to now rather than a fixed epoch on purpose: an
 * approval whose deadline has passed is correctly rendered inert, so a fixed
 * timestamp would silently disable the buttons in every test written after it
 * and make the approval path look broken when it is not.
 */
export function scriptedApproval(over: Partial<RuntimeApprovalView> = {}): RuntimeApprovalView {
  const now = Date.now()
  return {
    approvalId: "approval-1",
    sessionId: "session-1",
    provider: "claude-code",
    action: "Modify file",
    scope: "write_project",
    projectId: "project-1",
    targets: ["src/analysis.py"],
    requestedAt: now,
    expiresAt: now + 300_000,
    ...over,
  }
}
