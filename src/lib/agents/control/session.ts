import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The control plane's session lifecycle.
 *
 * ## Why this is not `AgentRunStatus`
 *
 * The domain already has a status for a run (`working`, `waiting`,
 * `completed`, `failed`, `blocked`, `cancelled`) and it stays exactly as it
 * is. It answers "how is the *work* going", derived from observation, and it
 * is the thing History and the Session View render.
 *
 * This answers a different question: "what is TabDump's *connection to this
 * agent* doing right now". A session can be `ready` with no run in flight, or
 * `waiting_for_approval` while the underlying run is still `working`. Folding
 * the two together would force one of those two truths to be wrong, which is
 * exactly the mistake the domain's own notes warn about for run-vs-work-item
 * status.
 *
 * The relationship is one-way and explicit: a control session *owns* zero or
 * more domain runs, and reports them through the existing observation path.
 * There is no second representation of a run anywhere in this directory.
 */
export type AgentSessionStatus =
  /** The session record exists. Nothing has been asked of the provider yet. */
  | "created"
  /** Reaching the provider. */
  | "connecting"
  /** Connected and idle — able to accept a message. */
  | "ready"
  /** The agent is working on something. */
  | "running"
  /** Stopped on a permission decision. Resumes when the approval is answered. */
  | "waiting_for_approval"
  /** Stopped on a question for the user. Resumes when they answer. */
  | "waiting_for_input"
  /** Finished normally. Terminal. */
  | "completed"
  /** Stopped on request. Terminal. */
  | "cancelled"
  /** Stopped by an error. Terminal. */
  | "failed"
  /** The connection is gone. Terminal for this session object; a resume mints a new one. */
  | "disconnected";

export const AGENT_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "created",
  "connecting",
  "ready",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "cancelled",
  "failed",
  "disconnected",
] as const;

export function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
  return typeof value === "string" && (AGENT_SESSION_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses a session never leaves.
 *
 * `disconnected` is terminal *for this session object*. Reattaching to the
 * same provider session is a `resumeSession` call that mints a new control
 * session carrying the same `providerSessionId` — it is not a transition back
 * to `ready`. Making it terminal is what stops a stale object from quietly
 * coming back to life while a newer one is already driving the same agent.
 */
export const TERMINAL_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "completed",
  "cancelled",
  "failed",
  "disconnected",
] as const;

export function isTerminalSessionStatus(status: AgentSessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

/** Statuses in which the agent is stopped, waiting on something only the user can supply. */
export const BLOCKED_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "waiting_for_approval",
  "waiting_for_input",
] as const;

export function isBlockedSessionStatus(status: AgentSessionStatus): boolean {
  return (BLOCKED_SESSION_STATUSES as readonly string[]).includes(status);
}

/** Statuses in which the session is holding a live connection to a provider. */
export const LIVE_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "connecting",
  "ready",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
] as const;

export function isLiveSessionStatus(status: AgentSessionStatus): boolean {
  return (LIVE_SESSION_STATUSES as readonly string[]).includes(status);
}

/**
 * Every transition the lifecycle permits, and no others.
 *
 * Written as an exhaustive table rather than as a guard function, because a
 * table can be read as a specification and a chain of `if`s cannot. Three
 * properties are deliberate:
 *
 *   - **`failed` and `disconnected` are reachable from every live state.** A
 *     provider can die at any moment and the model must be able to say so.
 *   - **`cancelled` is reachable only from states where something is
 *     actually running or blocked.** Cancelling a session that never started
 *     is a no-op, not a state change, and allowing it would let a UI report
 *     "cancelled" for work that never existed.
 *   - **Nothing leaves a terminal state.** The empty arrays are the whole
 *     reason this is a table: they are checked, not assumed.
 */
export const SESSION_TRANSITIONS: Record<AgentSessionStatus, readonly AgentSessionStatus[]> = {
  created: ["connecting", "failed", "disconnected", "cancelled"],
  connecting: ["ready", "failed", "disconnected", "cancelled"],
  // `ready -> waiting_*` is not a detour. Resuming a session that was already
  // blocked lands in `ready` and only then learns there is an approval or a
  // question outstanding, so the block has to be reachable without a run
  // having started in this process.
  ready: [
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "completed",
    "failed",
    "disconnected",
    "cancelled",
  ],
  running: [
    "waiting_for_approval",
    "waiting_for_input",
    "ready",
    "completed",
    "failed",
    "disconnected",
    "cancelled",
  ],
  waiting_for_approval: ["running", "failed", "disconnected", "cancelled"],
  waiting_for_input: ["running", "failed", "disconnected", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
  disconnected: [],
};

export function canTransition(from: AgentSessionStatus, to: AgentSessionStatus): boolean {
  return (SESSION_TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * A control session: TabDump's handle on one conversation with one agent.
 *
 * ## What it deliberately does not hold
 *
 * No transcript, no message bodies, no tool output, no file contents. A
 * session is the *handle* — who, where, what it is allowed to touch, and what
 * it is doing. What was said travels as events (see ./events.ts) and what was
 * done is recorded by the existing domain. Putting the conversation here
 * would make the session record unbounded and would put provider prose into
 * the one object that gets persisted.
 *
 * No credential either. See ./persistence.ts for why, and where that
 * genuinely belongs.
 */
export type AgentSession = {
  /** TabDump's own id. Stable across a resume; the provider's id may not be. */
  id: string;
  provider: AgentProviderId;
  /**
   * The provider's own identity for this conversation, opaque here.
   *
   * Absent until the provider has told us one. It is what `resumeSession`
   * carries, and it is never parsed — the same rule the observation plane
   * already applies to `AgentRun.externalId`.
   */
  providerSessionId?: string;
  status: AgentSessionStatus;
  /**
   * The project this session is authorized against, if any.
   *
   * Absent means the session has no local scope at all: it may not read,
   * write or execute anything on the machine, whatever its provider's
   * capabilities say. See ./permissions.ts — the check is on the grant, never
   * on the absence of one.
   */
  projectId?: string;
  /** The TabDump workspace this session belongs to, when one was chosen. */
  workspaceId?: string;
  /** Short human-readable label. Never provider prose — see ./events.ts on why. */
  title?: string;
  createdAt: number;
  updatedAt: number;
  /** Set exactly when the session reaches a terminal status. */
  endedAt?: number;
  /**
   * Runs this session has produced, by the domain's own run id.
   *
   * A reference, not a copy. The run itself lives where it always has, and
   * this is how the command centre finds it without the control plane
   * growing a second representation of work.
   */
  runIds: readonly string[];
};

export type SessionTransitionFailure = {
  ok: false;
  reason: "invalid-transition";
  from: AgentSessionStatus;
  to: AgentSessionStatus;
};

export type SessionTransitionResult =
  | { ok: true; session: AgentSession }
  | SessionTransitionFailure;

/**
 * Moves a session to a new status, or refuses.
 *
 * Returns a result rather than throwing, and returns a *new* session rather
 * than mutating: both match how the existing domain operations (`createRun`,
 * `transitionRunStatus`) already behave, so a caller that knows one knows
 * this.
 *
 * A transition to the status it is already in is refused rather than treated
 * as a no-op. `running -> running` looks harmless but would let a second
 * `sendMessage` silently overwrite the timestamps of the first, and a caller
 * that means "still running" should emit an event, not re-transition.
 */
export function transitionSession(
  session: AgentSession,
  to: AgentSessionStatus,
  now: number
): SessionTransitionResult {
  if (!canTransition(session.status, to)) {
    return { ok: false, reason: "invalid-transition", from: session.status, to };
  }

  const next: AgentSession = { ...session, status: to, updatedAt: now };
  if (isTerminalSessionStatus(to)) next.endedAt = now;

  return { ok: true, session: next };
}

export type CreateSessionInput = {
  id: string;
  provider: AgentProviderId;
  projectId?: string;
  workspaceId?: string;
  title?: string;
  providerSessionId?: string;
};

/** Mints a session in `created`. The only way one is born, so no session starts mid-lifecycle. */
export function createSession(input: CreateSessionInput, now: number): AgentSession {
  const session: AgentSession = {
    id: input.id,
    provider: input.provider,
    status: "created",
    createdAt: now,
    updatedAt: now,
    runIds: [],
  };

  if (input.providerSessionId) session.providerSessionId = input.providerSessionId;
  if (input.projectId) session.projectId = input.projectId;
  if (input.workspaceId) session.workspaceId = input.workspaceId;
  if (input.title) session.title = input.title;

  return session;
}

/**
 * Records that this session produced a domain run.
 *
 * Idempotent by run id: a provider re-reporting the same run on a reconnect
 * must not make the session claim two.
 */
export function attachRunToSession(
  session: AgentSession,
  runId: string,
  now: number
): AgentSession {
  if (session.runIds.includes(runId)) return session;
  return { ...session, runIds: [...session.runIds, runId], updatedAt: now };
}
