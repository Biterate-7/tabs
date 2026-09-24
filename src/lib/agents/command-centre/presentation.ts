import { APPROVAL_ACTION_LABELS } from "@/lib/agents/control/approvals";
import { AGENT_VISUAL_STATE_PRESENTATION } from "@/lib/agents/visual/states";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import type { AgentControlEventKind } from "@/lib/agents/control/events";
import type { AgentCapability } from "@/lib/agents/control/capabilities";
import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type { AgentVisualState, AgentVisualTone } from "@/lib/agents/visual/types";
import type {
  RuntimeErrorCode,
  RuntimePlanOutcomeView,
  RuntimeProviderStatus,
  RuntimeStatus,
} from "@/lib/agents/runtime/protocol";
import type { OperationConfidence } from "@/lib/agents/session-context/plan";

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

/**
 * What the user can *do* about a session that will not accept a message.
 *
 * The companion to `SESSION_STATUS_DETAIL`, and deliberately not a paraphrase
 * of it: the composer shows the detail as its placeholder, inside the control
 * it explains, so a second line repeating the same sentence underneath was
 * saying nothing twice. This map carries the next step instead.
 *
 * `null` means there is genuinely nothing to suggest — the agent is simply
 * busy and the user's move is to wait, which is not worth a line of type. A
 * status that needs no advice says so explicitly rather than being omitted,
 * so the record stays total over the union.
 */
export const SESSION_STATUS_RECOVERY: Record<AgentSessionStatus, string | null> = {
  created: null,
  connecting: null,
  ready: null,
  running: null,
  waiting_for_approval: "Answer the approval above to let the run continue.",
  waiting_for_input: null,
  completed: "Start a new session to keep going.",
  cancelled: "Start a new session to keep going.",
  failed: "Start a new session to keep going.",
  disconnected: "Reconnect the runtime, then start a new session.",
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
  message_delta: { register: "message", label: "", tone: "live", speaker: "agent" },
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
 * Workspace plans (Phase J.5)
 * ------------------------------------------------------------------ */

/**
 * What became of an approved plan, in one line, for the row where the user
 * approved it. Counts and a version only; "applied" is said only when the
 * runtime found every change in the synced workspace.
 */
export function planOutcomeLabel(outcome: RuntimePlanOutcomeView): { text: string; tone: AgentVisualTone } {
  const changes = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;
  switch (outcome.status) {
    case "applied":
      return { text: `${changes(outcome.operationCount)} applied · Context updated to v${outcome.contextVersion}`, tone: "good" };
    case "unverified":
      return {
        text: `Applied, but only ${outcome.verifiedCount} of ${changes(outcome.operationCount)} could be confirmed — check the workspace`,
        tone: "bad",
      };
    case "not_applied":
      return { text: "Not applied — the workspace no longer matched. Nothing was changed.", tone: "bad" };
    case "stale":
      return { text: "Not applied — the workspace changed while you were deciding. Nothing was changed.", tone: "muted" };
    case "denied":
      return { text: "Declined. Nothing was changed.", tone: "muted" };
    case "expired":
      return { text: "Expired. Nothing was changed.", tone: "muted" };
    case "cancelled":
      return { text: "The session ended. Nothing was changed.", tone: "muted" };
  }
}

/** How sure the agent said it was about one step — its words, shown as such. Never a number. */
export const PLAN_CONFIDENCE_LABEL: Record<OperationConfidence, string> = {
  high: "Confident",
  medium: "Fairly sure",
  unclear: "Unsure",
};

/** A TabDump context tool as a person reads it. */
const CONTEXT_TOOL_LABEL: Partial<Record<string, string>> = {
  get_workspace_summary: "Summarized the workspace",
  get_context_status: "Checked the workspace version",
  get_context_changes: "Checked what changed",
  get_current_workspace: "Read the workspace",
  list_workspaces: "Read the workspace",
  get_workspace: "Read the workspace",
  list_tabs: "Listed tabs",
  get_tabs: "Read tabs",
  search_tabs: "Searched tabs",
  find_duplicate_tabs: "Looked for duplicates",
  list_collections: "Listed collections",
  get_collection: "Read a collection",
  preview_workspace_plan: "Checked a plan",
  get_tab_graph: "Read related tabs",
  create_collection: "Proposed a collection",
  rename_collection: "Proposed a rename",
  add_tabs_to_collection: "Proposed adding tabs",
  propose_workspace_plan: "Proposed changes",
};

/**
 * `mcp__tabdump_<16 base32>__search_tabs` — how Claude Code names a call to
 * the session's context server — as "TabDump · Searched tabs". Only a name in
 * the minted server shape is recognised; anything else is shown as it came.
 * Display only: nothing is decided from it.
 */
export function toolDisplayName(name: string): string {
  const match = /^mcp__tabdump_[a-z2-7]{16}__([a-z_]+)$/.exec(name);
  const label = match ? CONTEXT_TOOL_LABEL[match[1]] : undefined;
  return label ? `TabDump · ${label}` : name;
}

/* ------------------------------------------------------------------ *
 * Permission scopes
 * ------------------------------------------------------------------ */

/**
 * An approval's action in words — "Create files", "Change your TabDump
 * workspace" — rather than its identifier. Unknown actions (a newer runtime)
 * fall back to the identifier rather than to nothing.
 */
export function approvalActionLabel(action: string): string {
  const label = (APPROVAL_ACTION_LABELS as Record<string, string>)[action];
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : action;
}

/**
 * What a permission scope is called when a person has to decide about it.
 *
 * `AgentPermissionScope` is an internal identifier — `write_project`,
 * `run_commands` — and the approval prompt was printing it verbatim next to
 * the action. That is the one place in the product where the user is being
 * asked to authorize something, and an identifier is the wrong register for
 * it: it reads as debug output, and a person who does not already know the
 * permission model cannot tell `write_project` from `read_project` at a
 * glance, which is exactly the distinction the decision turns on.
 *
 * The sentences are the doc comments on `AgentPermissionScope` itself, said
 * to the user rather than to the next developer. Total over the union, so a
 * new scope cannot be added to the control plane without being given words
 * here.
 */
export const PERMISSION_SCOPE_LABEL: Record<AgentPermissionScope, string> = {
  read_workspace: "Read TabDump content",
  read_project: "Read project files",
  write_project: "Change project files",
  run_commands: "Run commands",
  network_access: "Use the network",
  mcp_tools: "Use connected tools",
  write_workspace: "Change TabDump content",
};

/**
 * The scope's words, or the scope itself.
 *
 * `RuntimeApprovalView.scope` is a `string` on the wire rather than the narrow
 * union, because the host is a separate process that may be a version ahead.
 * An unrecognized scope is therefore possible, and it is returned **verbatim**
 * rather than prettified: this is an authorization prompt, and a scope TabDump
 * does not have words for is something the user should see exactly as the
 * runtime named it, not a guess dressed up as a sentence.
 */
export function permissionScopeLabel(scope: string): string {
  return PERMISSION_SCOPE_LABEL[scope as AgentPermissionScope] ?? scope;
}

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
  approval_unenforceable: {
    title: "Agent would not ask before acting",
    action: "TabDump only runs agents that ask for approval. Check the agent's own approval settings, then start a new session.",
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
  /**
   * Which plane is executing, when one is.
   *
   * `null` means nothing is. Kept separate from `title` so a caller can render
   * the short `REMOTE · Ready` form the brief asks for without parsing a
   * sentence back apart.
   */
  environment: "local" | "remote" | null;
};

/**
 * The short form for the top runtime bar.
 *
 * `REMOTE · Ready` rather than `Agent runtime unavailable`, when remote
 * execution is genuinely available — which is the specific change the brief
 * asks for, and the reason it matters is that the old sentence was *true* for
 * a hosted deployment and is now false. A user on tabsdump.vercel.app whose
 * agent is running in a sandbox should not be told agents cannot run.
 */
export function runtimeBadge(status: RuntimeStatus | null): string {
  const banner = runtimeBanner(status);
  if (!banner.environment) return banner.title;
  return `${banner.environment === "remote" ? "REMOTE" : "LOCAL"} · ${banner.title}`;
}

export function runtimeBanner(status: RuntimeStatus | null): RuntimeBanner {
  if (!status) {
    return {
      tone: "bad",
      title: "Disconnected",
      detail: "TabDump cannot reach an agent runtime.",
      reconnectable: true,
      environment: null,
    };
  }

  if (status.executable) {
    // The two executing planes read differently on purpose. "Agents run on
    // this machine" and "agents run in an isolated environment TabDump
    // created" are different promises about where a user's files are, and
    // collapsing them into "Ready" would conceal the one fact that decides
    // whether the blast radius includes their home directory.
    const remote = status.environment === "remote";
    return {
      tone: "good",
      title: "Ready",
      detail: remote
        ? "Agents run in an isolated environment TabDump creates for each project. They cannot reach this computer."
        : "Agents run on this machine, in the projects you authorize.",
      reconnectable: false,
      environment: remote ? "remote" : "local",
    };
  }

  // `detail` is the gate's own sentence (RUNTIME_DENIAL_MESSAGES or
  // REMOTE_DENIAL_MESSAGES), which is already fixed text and already safe.
  // Falling back rather than assuming it is present, because the protocol
  // marks it optional.
  return {
    tone: "muted",
    title: "Unavailable",
    detail:
      status.detail ??
      "This build of TabDump cannot run agents. Workspaces, tabs and context still work.",
    reconnectable: false,
    environment: null,
  };
}

/* ------------------------------------------------------------------ *
 * Remote projects
 * ------------------------------------------------------------------ */

/**
 * What a remote project's sandbox is doing, in words.
 *
 * Total over the lifecycle union, so a state added to the remote plane is a
 * type error here rather than a silently unlabelled row. Each sentence says
 * what the user can do next, because a status with no next step is a status
 * that reads as an error whatever its tone.
 */
export const REMOTE_STATUS_LABEL: Record<string, string> = {
  creating: "Creating environment…",
  ready: "Ready",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  expired: "Expired",
  failed: "Failed",
};

export const REMOTE_STATUS_DETAIL: Record<string, string> = {
  creating: "TabDump is setting up an isolated environment for this project.",
  ready: "The environment is warm and holds this project's files.",
  running: "An agent is working in this project.",
  stopping: "The environment is shutting down.",
  stopped: "The environment was stopped. Starting a session will bring it back with your files.",
  expired: "The environment timed out. Starting a session will bring it back with your files.",
  failed: "The environment could not be created. Try creating the project again.",
};

export const REMOTE_STATUS_TONE: Record<string, AgentVisualTone> = {
  creating: "idle",
  ready: "good",
  running: "live",
  stopping: "idle",
  stopped: "muted",
  expired: "muted",
  failed: "bad",
};

export function remoteStatusLabel(status: string): string {
  return REMOTE_STATUS_LABEL[status] ?? status;
}

/**
 * Whether a session can be started against this project right now.
 *
 * A stopped or expired environment is *not* excluded: starting a session
 * resumes it, with the project's files intact, which is the whole point of a
 * persistent remote project. Only the two states that genuinely cannot accept
 * one are.
 */
export function canStartRemoteSession(status: string): boolean {
  return status !== "creating" && status !== "failed";
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
 * What a provider row says, from both of the runtime's facts (Phase J.2).
 *
 * "Connected" alone describes the process — TabDump reached the agent. An
 * agent that was reached and then said it is signed out is not connected in
 * any sense a person means, so the agent's own answer wins.
 */
export function providerRowState(provider: RuntimeProviderStatus): { label: string; tone: AgentVisualTone } {
  if (provider.connection === "connected" && provider.authentication === "required") {
    return { label: "Sign-in required", tone: "idle" };
  }
  return { label: PROVIDER_CONNECTION_LABEL[provider.connection], tone: PROVIDER_CONNECTION_TONE[provider.connection] };
}

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
