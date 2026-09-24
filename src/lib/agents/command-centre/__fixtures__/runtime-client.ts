import { runtimeFailure } from "@/lib/agents/runtime/protocol"
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
  } = {}
): ScriptedRuntime {
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
        })
        sessions = [...sessions, created]
        return { ok: true, value: created }
      }

      case "dispose_session":
        sessions = sessions.filter((s) => s.sessionId !== command.sessionId)
        return { ok: true, value: { sessionId: command.sessionId } }

      case "send_message":
      case "cancel_run":
      case "attach_context":
      case "detach_context":
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
        const view = connectionViews.get(command.provider)
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
    action: "Modify file",
    scope: "write_project",
    projectId: "project-1",
    targets: ["src/analysis.py"],
    requestedAt: now,
    expiresAt: now + 300_000,
    ...over,
  }
}
