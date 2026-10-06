import { runtimeFailure } from "@/lib/agents/runtime/protocol"
import { reviveHistoryChange } from "@/lib/agents/activity/history"
import type { AgentHistoryStore } from "@/lib/agents/activity/history-store"
import { snapshotFingerprint } from "@/lib/agents/session-context/snapshot"
import { attachmentsStayIn, focusFitsSnapshot, focusFromAttachments, isEmptyFocus } from "@/lib/agents/session-context/focus"
import type { AgentAttachedContext } from "@/lib/agents/control/context"
import type { ControlContextDeliveryInfo } from "@/lib/agents/control/events"
import { contextDeliveryOf } from "@/lib/agents/context-pack/provenance"
import { contextPackAttachedContext } from "@/lib/agents/context-pack/attach"
import { contextWorldOfSnapshot, handoffContextPack } from "@/lib/agents/context-pack/handoff"
import { canHandOffFrom, handoffLinksOf, readHandoffInstruction, selectHandoffContext } from "@/lib/agents/handoff/handoff"
import { prepareHandoffPreview } from "@/lib/agents/handoff/preview"
import type { HandoffFailure, SessionHandoff } from "@/lib/agents/handoff/handoff"
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot"
import type { RuntimeClient } from "@/lib/agents/runtime/client"
import type { ProjectInspection } from "@/lib/agents/project/inspection"
import type { ProjectChangeReview } from "@/lib/agents/project/changes"
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
  /** Makes the next `start_handoff` end as this failure, as the host reports one (Hubble 1.4). */
  failHandoff: (failure: HandoffFailure | null) => void
  /** Handoffs the runtime recorded. */
  readonly handoffs: readonly SessionHandoff[]
  /** Messages sent, with the context each delivered — as the host records it on the message (Hubble 1.5). */
  readonly sentMessages: readonly { sessionId: string; text: string; delivery?: ControlContextDeliveryInfo }[]
  /** What `inspect_project` answers for a project (Hubble 1.6). Absent: refused as unknown. */
  setInspection: (projectId: string, inspection: Omit<ProjectInspection, "projectId" | "inspectedAt"> | null) => void
  /** What `undo_project_change` answers. Default: undone, one file. */
  setUndoResult: (result: { outcome: "undone" | "refused" | "partial"; reason?: "changed" | "no_copy" | "unavailable" | "sensitive"; files: number }) => void
  /** What `review_project_change` answers. Default: refused. */
  setReview: (review: ProjectChangeReview | null) => void
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
  const handoffs: SessionHandoff[] = []
  const sentMessages: { sessionId: string; text: string; delivery?: ControlContextDeliveryInfo }[] = []
  let handoffFailure: HandoffFailure | null = null
  const inspections = new Map<string, Omit<ProjectInspection, "projectId" | "inspectedAt">>()
  let undoResult: { outcome: "undone" | "refused" | "partial"; reason?: "changed" | "no_copy" | "unavailable" | "sensitive"; files: number } = { outcome: "undone", files: 1 }
  let review: ProjectChangeReview | null = null
  let checkCounter = 0
  /** Each session as the host describes it: with its handoff links, from the records. */
  const linked = (view: RuntimeSessionView): RuntimeSessionView => {
    const links = handoffLinksOf(view.sessionId, handoffs)
    if (!links) return view
    return { ...view, handoff: links }
  }

  /** What the host's `handoffCandidate` decides, with the same preview function. */
  function handoffCandidate(command: Extract<RuntimeCommand, { name: "prepare_handoff" | "start_handoff" }>) {
    const source = sessions.find((s) => s.sessionId === command.sourceSessionId)
    if (!source) return runtimeFailure<never>("session_not_found")
    const workspaceId = source.workspaceId ?? source.context?.workspaceId
    if (!workspaceId || !canHandOffFrom(source.status)) return runtimeFailure<never>("invalid_session_state")
    const target = status.providers.find((entry) => entry.provider === command.targetProvider)
    if (!target?.available || !target.capabilities.includes("create_session")) return runtimeFailure<never>("provider_unavailable")
    if (command.contextSnapshot && command.contextSnapshot.workspace.id !== workspaceId) return runtimeFailure<never>("context_invalid")
    const prepared = prepareHandoffPreview({
      session: source,
      workspaceId,
      events: events.filter((event) => event.sessionId === source.sessionId),
      changes: [],
      ...(command.contextSnapshot ? { snapshot: command.contextSnapshot } : {}),
      ...(source.focus ? { focus: source.focus } : {}),
      targetProvider: command.targetProvider,
      contextTools: true,
      now: 1_700_000_000_000,
    })
    return { ok: true as const, value: { source, workspaceId, ...prepared } }
  }
  /** The snapshot each session was started with — what the host would check a focus against. */
  const snapshots = new Map<string, SessionContextSnapshot>()
  /** The context attached to each session, for what its next message records delivering (Hubble 1.5). */
  const attachedContexts = new Map<string, AgentAttachedContext>()

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
    attachedContexts.set(view.sessionId, context)
    return {
      ...rest,
      contextSnapshotId: context.snapshotId,
      contextDelivered: false,
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
        return { ok: true, value: { sessions: sessions.map(linked), correlations } }

      case "get_session": {
        const found = sessions.find((s) => s.sessionId === command.sessionId)
        if (!found) return runtimeFailure<never>("session_not_found")
        const related = handoffs.filter((h) => h.sourceSessionId === found.sessionId || h.targetSessionId === found.sessionId)
        return { ok: true, value: { session: linked(found), approvals, ...(related.length > 0 ? { handoffs: related } : {}) } }
      }

      /* Hubble 1.4 — explicit handoff, as the host answers it. */
      case "prepare_handoff": {
        const candidate = handoffCandidate(command)
        return candidate.ok ? { ok: true, value: candidate.value.preview } : candidate
      }

      case "start_handoff": {
        const candidate = handoffCandidate(command)
        if (!candidate.ok) return candidate
        const { source, workspaceId, preview, focus } = candidate.value
        if (preview.fingerprint !== command.fingerprint) return runtimeFailure<never>("context_invalid")
        const instruction = readHandoffInstruction(command.instruction)
        const record: SessionHandoff = {
          handoffId: `handoff-${handoffs.length + 1}`,
          workspaceId,
          sourceSessionId: source.sessionId,
          sourceProvider: source.provider,
          targetProvider: command.targetProvider,
          status: "ready",
          context: selectHandoffContext(preview.context, command.include),
          ...(instruction ? { instruction } : {}),
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        }
        if (handoffFailure === "session_not_created") {
          handoffs.push({ ...record, status: "failed", failure: "session_not_created" })
          return { ok: true, value: { handoff: handoffs[handoffs.length - 1], error: { code: "provider_error", message: "The agent stopped unexpectedly." } } }
        }
        // The canonical Context Pack goes with the envelope, as the host sends it (Hubble 1.5).
        const pack =
          record.context.workspace && command.contextSnapshot
            ? handoffContextPack({
                world: contextWorldOfSnapshot(command.contextSnapshot),
                workspaceId,
                ...(focus ? { focus } : {}),
                context: record.context,
                ...(instruction ? { instruction } : {}),
              })
            : undefined
        const packed = pack ? contextPackAttachedContext(pack, 1_700_000_000_000) : null
        const target = scriptedSession({
          sessionId: `session-${sessions.length + 1}`,
          provider: command.targetProvider,
          status: "running",
          workspaceId,
          ...(source.title ? { title: source.title } : {}),
          ...(command.projectId ? { projectId: command.projectId } : {}),
          ...(packed ? { contextSnapshotId: packed.snapshotId, contextDelivered: true } : {}),
          ...(packed && focus && (focus.tabIds.length > 0 || focus.collectionIds.length > 0)
            ? { focus: { tabIds: [...focus.tabIds], collectionIds: [...focus.collectionIds], delivered: true } }
            : {}),
        })
        if (packed) attachedContexts.set(target.sessionId, packed)
        sessions = [...sessions, target]
        if (handoffFailure === "context_not_delivered") {
          handoffs.push({ ...record, targetSessionId: target.sessionId, status: "failed", failure: "context_not_delivered" })
          return { ok: true, value: { handoff: handoffs[handoffs.length - 1], session: target, error: { code: "provider_error", message: "The agent stopped unexpectedly." } } }
        }
        handoffs.push({ ...record, targetSessionId: target.sessionId })
        const info = { handoffId: record.handoffId, workspaceId }
        for (const event of [
          { sessionId: target.sessionId, provider: target.provider, kind: "handoff_received" as const, handoff: { ...info, peerProvider: source.provider, peerSessionId: source.sessionId } },
          { sessionId: source.sessionId, provider: source.provider, kind: "handoff_sent" as const, handoff: { ...info, peerProvider: target.provider, peerSessionId: target.sessionId, outcome: "ready" as const } },
        ]) {
          events = [...events, { id: `handoff-event-${events.length + 1}`, timestamp: 1_700_000_000_000, summary: "", ...event, sequence: events.length + 1 }]
        }
        return { ok: true, value: { handoff: handoffs[handoffs.length - 1], session: linked(target) } }
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
        const { focus: _focus, contextSnapshotId: _snapshot, contextDelivered: _delivered, ...rest } = target
        void _focus
        void _snapshot
        void _delivered
        attachedContexts.delete(target.sessionId)
        sessions = sessions.map((s) => (s.sessionId === target.sessionId ? rest : s))
        return { ok: true, value: rest }
      }

      case "send_message": {
        const target = sessions.find((s) => s.sessionId === command.sessionId)
        if (!target) return runtimeFailure<never>("session_not_found")
        // Attached context goes with this message, once — and, as the host
        // does, the message records what it delivered.
        const owed = target.contextDelivered === false ? attachedContexts.get(target.sessionId) : undefined
        const workspaceId = target.context?.workspaceId ?? target.workspaceId
        const delivery = owed && workspaceId ? contextDeliveryOf(owed, workspaceId) : undefined
        const sent = {
          ...target,
          ...(target.focus ? { focus: { ...target.focus, delivered: true } } : {}),
          ...(target.contextSnapshotId ? { contextDelivered: true } : {}),
        }
        sessions = sessions.map((s) => (s.sessionId === target.sessionId ? sent : s))
        sentMessages.push({ sessionId: target.sessionId, text: command.text, ...(delivery ? { delivery } : {}) })
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

      /* Project execution (Hubble 1.6), answered as the host answers it. */
      case "inspect_project": {
        const found = inspections.get(command.projectId)
        if (!found) return runtimeFailure<never>("project_scope_violation")
        return { ok: true, value: { projectId: command.projectId, inspectedAt: 1_700_000_000_000, ...found } }
      }
      case "run_project_check":
        if (!sessions.some((s) => s.sessionId === command.sessionId)) return runtimeFailure<never>("session_not_found")
        return { ok: true, value: { checkId: `check-${++checkCounter}` } }
      case "undo_project_change":
        if (!sessions.some((s) => s.sessionId === command.sessionId)) return runtimeFailure<never>("session_not_found")
        return { ok: true, value: undoResult }
      case "review_project_change":
        return review ? { ok: true, value: review } : runtimeFailure<never>("invalid_request")

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
    failHandoff: (failure) => {
      handoffFailure = failure
    },
    handoffs,
    sentMessages,
    setInspection: (projectId, inspection) => {
      if (inspection) inspections.set(projectId, inspection)
      else inspections.delete(projectId)
    },
    setUndoResult: (next) => {
      undoResult = next
    },
    setReview: (next) => {
      review = next
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
