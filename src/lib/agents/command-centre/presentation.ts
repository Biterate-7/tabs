import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import type { AgentControlEventKind } from "@/lib/agents/control/events";
import type { AgentCapability } from "@/lib/agents/control/capabilities";
import type { AgentVisualState, AgentVisualTone } from "@/lib/agents/visual/types";
import type {
  RuntimeErrorCode,
  RuntimeProviderStatus,
  RuntimeStatus,
} from "@/lib/agents/runtime/protocol";

/**
 * How the command centre says what the control plane means.
 *
 * ## Why this is a module and not a pile of ternaries in components
 *
 * Every mapping here answers a question the *backend* has already decided:
 * which session states may accept a message, what a `project_scope_violation`
 * should read as, whether a run is still live. A component that re-derived any
 * of them would be a second, quieter copy of the state machine — and the two
 * would drift, with the UI being the one that lies.
 *
 * So the rule this file exists to enforce is: **the UI restates backend state,
 * it never computes it.** Everything below is a total function over a closed
 * union, so adding a state to the control plane is a type error here rather
 * than a silently unlabelled pill in the interface.
 *
 * It is also pure and DOM-free, which is what makes the behaviour testable
 * without rendering anything.
 */

/* ------------------------------------------------------------------ *
 * Session status
 * ------------------------------------------------------------------ */

/**
 * The session's state in the vocabulary the rest of the product already
 * draws.
 *
 * TabDump has exactly one answer to "what colour is a working agent" —
 * `AgentVisualState`, shared by the graph's agent layer, the activity list and
 * the status pill. A control session mapping into that union rather than
 * inventing tones is what stops a session that the header calls *running* from
 * being drawn beside an observed run in a different colour.
 *
 * `created` maps to `queued` rather than `idle`: a session that exists and has
 * been asked for nothing yet is work that has not started, which is precisely
 * what `queued` means.
 */
export const SESSION_VISUAL_STATE: Record<AgentSessionStatus, AgentVisualState> = {
  created: "queued",
  connecting: "starting",
  ready: "idle",
  running: "working",
  waiting_for_approval: "waiting",
  waiting_for_input: "waiting",
  completed: "success",
  cancelled: "idle",
  failed: "error",
  disconnected: "error",
};

/**
 * The words on screen.
 *
 * Deliberately not `startCase(status)`: "Waiting for approval" and "Waiting
 * for input" are different situations for the user and must not both collapse
 * into "Waiting", and `disconnected` reads better as the thing that happened
 * to the connection than as a property of the session.
 */
export const SESSION_STATUS_LABEL: Record<AgentSessionStatus, string> = {
  created: "Created",
  connecting: "Connecting",
  ready: "Ready",
  running: "Running",
  waiting_for_approval: "Waiting for approval",
  waiting_for_input: "Waiting for input",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  disconnected: "Disconnected",
};

/** One sentence of "what is happening", for a header or an empty stream. */
export const SESSION_STATUS_DETAIL: Record<AgentSessionStatus, string> = {
  created: "The session exists. Nothing has been sent yet.",
  connecting: "Reaching the provider.",
  ready: "Connected and idle.",
  running: "The agent is working.",
  waiting_for_approval: "Stopped on a permission decision.",
  waiting_for_input: "The agent asked a question.",
  completed: "The run finished.",
  cancelled: "The run was stopped.",
  failed: "The run stopped on an error.",
  disconnected: "The connection is gone.",
};

export function sessionStatusTone(status: AgentSessionStatus): AgentVisualTone {
  return AGENT_VISUAL_STATE_PRESENTATION[SESSION_VISUAL_STATE[status]].tone;
}

/**
 * Terminal states, named once.
 *
 * Mirrors `AgentSessionStatus`'s own doc comments — the four it calls
 * "Terminal". A session in one of these cannot be sent to, cancelled, or
 * attached to, and the composer, the cancel button and the context picker all
 * read this rather than each listing statuses.
 */
export const TERMINAL_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "completed",
  "cancelled",
  "failed",
  "disconnected",
] as const;

export function isTerminalSession(status: AgentSessionStatus): boolean {
  return TERMINAL_SESSION_STATUSES.includes(status);
}

/**
 * Whether the agent is doing something right now.
 *
 * Used to decide whether to keep polling and whether to animate — and for no
 * other purpose. It is not "may I send a message", which is the separate
 * question below.
 */
export function isLiveSession(status: AgentSessionStatus): boolean {
  return status === "connecting" || status === "running";
}

/**
 * Whether the composer may send.
 *
 * ## Why this is not simply `!isTerminal`
 *
 * `running` is not terminal and still must not accept a message: the control
 * plane answers `invalid_session_state`, and a composer that let the user type
 * into it would be offering something it knows will be refused.
 * `waiting_for_approval` is the same — the approval is the input the session is
 * blocked on, and the brief is explicit that an outstanding approval must be
 * answered rather than talked past.
 *
 * So this is an allow-list of the two statuses that genuinely accept text.
 */
export function canSendMessage(status: AgentSessionStatus): boolean {
  return status === "ready" || status === "waiting_for_input" || status === "created";
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/**
 * The three registers the stream renders in.
 *
 * A conversation is not a flat list of equal things: what the user said and
 * what the agent said are the spine, what a tool did is supporting detail, and
 * a lifecycle fact is neither. Grouping them here — rather than in the
 * component — is what lets the stream give each register its own density
 * without a component knowing nineteen event kinds.
 */
export type EventRegister = "message" | "activity" | "lifecycle";

export type EventPresentation = {
  register: EventRegister;
  /** The row's label. Empty for a message, whose body is the summary itself. */
  label: string;
  tone: AgentVisualTone;
  /** Who the row is attributed to, when it is a message. */
  speaker?: "user" | "agent";
};

export const EVENT_PRESENTATION: Record<AgentControlEventKind, EventPresentation> = {
  session_started: { register: "lifecycle", label: "Session started", tone: "muted" },
  session_resumed: { register: "lifecycle", label: "Session resumed", tone: "muted" },
  message_sent: { register: "message", label: "", tone: "idle", speaker: "user" },
  message_received: { register: "message", label: "", tone: "idle", speaker: "agent" },
  thinking: { register: "activity", label: "Thinking", tone: "live" },
  tool_started: { register: "activity", label: "Tool", tone: "live" },
  tool_finished: { register: "activity", label: "Tool", tone: "idle" },
  file_read: { register: "activity", label: "Read", tone: "idle" },
  file_created: { register: "activity", label: "Created", tone: "good" },
  file_modified: { register: "activity", label: "Modified", tone: "good" },
  command_started: { register: "activity", label: "Command", tone: "live" },
  command_finished: { register: "activity", label: "Command", tone: "idle" },
  approval_requested: { register: "lifecycle", label: "Approval requested", tone: "bad" },
  approval_granted: { register: "lifecycle", label: "Approval granted", tone: "good" },
  approval_denied: { register: "lifecycle", label: "Approval denied", tone: "bad" },
  waiting_for_input: { register: "lifecycle", label: "Waiting for input", tone: "idle" },
  error: { register: "lifecycle", label: "Error", tone: "bad" },
  run_completed: { register: "lifecycle", label: "Run completed", tone: "good" },
  run_cancelled: { register: "lifecycle", label: "Run cancelled", tone: "muted" },
};

/* ------------------------------------------------------------------ *
 * Runtime errors
 * ------------------------------------------------------------------ */

/**
 * What a failed command tells the user.
 *
 * ## The rule this encodes
 *
 * The brief forbids collapsing backend errors into "Something went wrong", and
 * forbids showing a stack trace. Both failures come from the same root cause:
 * nobody decided, per code, what the user is supposed to *do*. So each entry
 * has a `title` (what happened) and an `action` (what to do about it), and the
 * type makes it impossible to add a code without answering both.
 *
 * Nothing here interpolates a value from a response. A runtime message can
 * carry a path or a host; these sentences are fixed text chosen at build time.
 */
export type RuntimeErrorPresentation = {
  title: string;
  action: string;
  /**
   * Whether the client should re-handshake before the user retries.
   *
   * Only the two codes that mean "the host you were talking to is not the host
   * that is there now". Everything else is a decision about the request, and
   * re-handshaking would hide it.
   */
  reconnect: boolean;
};

export const RUNTIME_ERROR_PRESENTATION: Record<RuntimeErrorCode, RuntimeErrorPresentation> = {
  runtime_unavailable: {
    title: "Agent runtime unavailable",
    action: "This build of TabDump cannot run agents. Workspaces, tabs and context still work.",
    reconnect: false,
  },
  runtime_disconnected: {
    title: "Runtime disconnected",
    action: "TabDump lost the local runtime. Reconnect to continue.",
    reconnect: true,
  },
  ownership_denied: {
    title: "Session belongs to another instance",
    action: "Reconnect, then start a new session.",
    reconnect: true,
  },
  provider_unavailable: {
    title: "Provider unavailable",
    action: "No adapter is registered for this agent here.",
    reconnect: false,
  },
  authentication_required: {
    title: "Agent not signed in",
    action: "Sign in to the provider on this machine, then try again.",
    reconnect: false,
  },
  session_not_found: {
    title: "Session not found",
    action: "It may have ended. Start a new session.",
    reconnect: false,
  },
  invalid_session_state: {
    title: "Not possible right now",
    action: "The session is busy or has ended. Wait for the run to finish.",
    reconnect: false,
  },
  permission_denied: {
    title: "Permission denied",
    action: "The project's grant does not cover this. Widen it in the project's permissions.",
    reconnect: false,
  },
  approval_required: {
    title: "Approval outstanding",
    action: "Answer the pending approval before continuing.",
    reconnect: false,
  },
  project_scope_violation: {
    title: "Project not authorized",
    action: "Authorize the project for this agent, then try again.",
    reconnect: false,
  },
  context_invalid: {
    title: "Context could not be attached",
    action: "Rebuild the context selection and attach it again.",
    reconnect: false,
  },
  provider_error: {
    title: "The agent failed",
    action: "The provider stopped on an error. Check the event stream, then retry.",
    reconnect: false,
  },
  cancellation: {
    title: "Run cancelled",
    action: "The run was stopped.",
    reconnect: false,
  },
  timeout: {
    title: "The agent did not answer",
    action: "The provider timed out. Try again.",
    reconnect: false,
  },
  invalid_request: {
    title: "TabDump sent something the runtime refused",
    action: "This is a bug in TabDump. Reload and try again.",
    reconnect: false,
  },
  unsupported: {
    title: "Not supported by this agent",
    action: "This provider does not implement that yet.",
    reconnect: false,
  },
};

/* ------------------------------------------------------------------ *
 * Runtime status
 * ------------------------------------------------------------------ */

/**
 * The single sentence the shell shows about whether agents can run at all.
 *
 * ## Why `executable` is the only thing consulted
 *
 * The brief forbids inferring runtime availability from the user agent, the
 * hostname, `NODE_ENV`, `PATH` or a Tauri global — and this is the function
 * that would be tempted to do it. It reads `status.executable`, which the
 * server-side gate set, and nothing else. A `null` status (no reply at all)
 * is reported as disconnected rather than optimistically assumed live.
 */
export type RuntimeBanner = {
  tone: AgentVisualTone;
  title: string;
  detail: string;
  /** Whether the UI should offer a reconnect affordance. */
  reconnectable: boolean;
};

export function runtimeBanner(status: RuntimeStatus | null): RuntimeBanner {
  if (!status) {
    return {
      tone: "bad",
      title: "Runtime disconnected",
      detail: "TabDump cannot reach a local agent runtime.",
      reconnectable: true,
    };
  }

  if (status.executable) {
    return {
      tone: "good",
      title: "Local runtime ready",
      detail: "Agents run on this machine.",
      reconnectable: false,
    };
  }

  // `detail` is the gate's own sentence (RUNTIME_DENIAL_MESSAGES), which is
  // already fixed text and already safe. Falling back rather than assuming it
  // is present, because the protocol marks it optional.
  return {
    tone: "muted",
    title: "Agent runtime unavailable",
    detail:
      status.detail ??
      "This build of TabDump cannot run agents. Workspaces, tabs and context still work.",
    reconnectable: false,
  };
}

/** What a provider row says about itself. */
export const PROVIDER_CONNECTION_LABEL: Record<RuntimeProviderStatus["connection"], string> = {
  unavailable: "Unavailable",
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  configuration_required: "Needs setup",
  error: "Error",
};

export const PROVIDER_CONNECTION_TONE: Record<
  RuntimeProviderStatus["connection"],
  AgentVisualTone
> = {
  unavailable: "muted",
  disconnected: "muted",
  connecting: "idle",
  connected: "good",
  configuration_required: "idle",
  error: "bad",
};

/**
 * Whether this provider can start a session here.
 *
 * Both halves are required and neither is inferred: the adapter must be
 * loaded (`available`) *and* must have declared the capability. A provider
 * that is present but has not claimed `create_session` — which is Codex's
 * situation on this branch — is offered as a row the user can see and not as
 * a button that would fail.
 */
export function canCreateSession(provider: RuntimeProviderStatus): boolean {
  return provider.available && provider.capabilities.includes("create_session");
}

export function hasCapability(
  provider: RuntimeProviderStatus | undefined,
  capability: AgentCapability
): boolean {
  return provider !== undefined && provider.capabilities.includes(capability);
}

/**
 * Why a provider cannot be chosen, when it cannot.
 *
 * `null` means it can. Returning the reason rather than a boolean is what lets
 * a disabled row say "Not installed" instead of being mysteriously grey.
 */
export function providerUnavailableReason(provider: RuntimeProviderStatus): string | null {
  if (!provider.available) return "Not available on this machine";
  if (provider.connection === "configuration_required") return "Needs setup";
  if (!provider.capabilities.includes("create_session")) return "Cannot start sessions yet";
  return null;
}

/* ------------------------------------------------------------------ *
 * Correlation
 * ------------------------------------------------------------------ */

/**
 * How a session came to be known, in one phrase.
 *
 * ## Why this is computed from two independent facts
 *
 * The observation and control planes are separate by design, and the brief
 * requires that the UI not merge them into a fake execution model. The honest
 * statement is a function of which halves of the correlation record actually
 * exist: a `controlRunId` means TabDump started it, an `observationRunId`
 * means TabDump saw it, and both mean both. Nothing here infers control from
 * the mere existence of a provider.
 */
export type SessionOrigin = "controlled" | "observed" | "controlled-and-observed" | "unknown";

export function sessionOrigin(input: {
  controlRunId?: string;
  observationRunId?: string;
}): SessionOrigin {
  const controlled = Boolean(input.controlRunId);
  const observed = Boolean(input.observationRunId);

  if (controlled && observed) return "controlled-and-observed";
  if (controlled) return "controlled";
  if (observed) return "observed";
  return "unknown";
}

export const SESSION_ORIGIN_LABEL: Record<SessionOrigin, string> = {
  controlled: "Controlled session",
  observed: "Observed externally",
  "controlled-and-observed": "Controlled + observed",
  unknown: "Not yet correlated",
};
