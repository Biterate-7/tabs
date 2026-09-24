import type { AgentCapability, AgentCapabilitySet } from "./capabilities";
import type { AgentContextAttachment, AgentMessageInput } from "./context";
import type { AgentControlEvent } from "./events";
import type { AgentPermissionGrant } from "./permissions";
import type { AgentProject } from "./projects";
import type { AgentSessionStatus } from "./session";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The control plane's provider seam.
 *
 * ## The principle
 *
 * > TabDump observes agents through the observation plane, and communicates
 * > with agents through a separately permissioned control plane.
 *
 * `AgentConnector` (../connectors/types.ts) is the observation plane and is
 * unchanged: it cannot act, and its guard tests still say so. This is the
 * other plane. The separation is the safety model — a provider that can be
 * watched is not thereby a provider that can be driven, and the two
 * capabilities are declared, permissioned and tested apart.
 *
 * ## What may never appear in this interface
 *
 * Nothing provider-shaped. No `permissionMode`, no `allowedTools`, no
 * `--add-dir`, no `sessionId` format, no model name, no CLI flag, no argv, no
 * shell string. Those are Claude Code's vocabulary, or Codex's, and an
 * interface that named one would stop being an abstraction the moment the
 * second provider arrived — it would become Claude's API with other providers
 * awkwardly pretending.
 *
 * The rule in practice: this file must read identically whether or not Claude
 * Code exists. `security.test.ts` enforces it by asserting that no provider
 * name appears in this module's executable code.
 *
 * ## What an adapter may not do
 *
 * An adapter is handed an already-authorized, already-validated request. It
 * does not decide permissions, does not resolve project paths, does not
 * consult the runtime boundary and does not mint approvals on its own
 * authority — the service does all four before dispatch, and the guard tests
 * assert the adapter directory cannot reach the modules that would let it.
 */

/**
 * Why a control operation did not happen.
 *
 * A closed code plus a message chosen from a fixed table, exactly as
 * `ConnectorError` already works — and for the same reason. An error is the
 * easiest path for a provider string to reach a screen or a log, and the only
 * way to be sure it cannot is to have nowhere to put one.
 */
export type ControlErrorCode =
  /** The adapter does not implement this capability. The Phase B answer for everything. */
  | "unsupported"
  /** This environment may not execute agents. See ./runtime.ts. */
  | "runtime-denied"
  /** The user has not granted the permission this operation needs. */
  | "permission-denied"
  /** An approval was required and was not granted. */
  | "approval-required"
  /** The named project is unknown, or this provider is not authorized for it. */
  | "project-denied"
  /** No such session, or it is in a status that cannot accept this. */
  | "invalid-session"
  /** The request itself was malformed. */
  | "invalid-request"
  /** The provider could not be reached. */
  | "unreachable"
  /** The provider did not answer in time. */
  | "timeout"
  /** The provider answered with something unreadable. */
  | "malformed-response"
  /** The provider needs configuration the user has not supplied. */
  | "configuration"
  /**
   * The agent would not work in a mode where it asks before acting, so
   * TabDump could not be the one approving what it does (Phase J.2).
   */
  | "approval-unenforceable"
  | "unknown";

export type ControlError = {
  code: ControlErrorCode;
  /** Short, human-readable, known-safe: from the table below, never interpolated from provider data. */
  message: string;
};

const CONTROL_ERROR_MESSAGES: Record<ControlErrorCode, string> = {
  unsupported: "This agent cannot do that yet.",
  "runtime-denied": "Agents cannot run in this environment.",
  "permission-denied": "This agent has not been given permission for that.",
  "approval-required": "That needs your approval first.",
  "project-denied": "This agent is not authorized for that project.",
  "invalid-session": "That session cannot accept this right now.",
  "invalid-request": "TabDump could not read that request.",
  unreachable: "Could not reach the agent.",
  timeout: "The agent did not respond in time.",
  "malformed-response": "The agent returned something TabDump could not read.",
  configuration: "This agent needs to be set up first.",
  "approval-unenforceable": "This agent would not agree to ask before acting, so TabDump did not start it.",
  unknown: "The agent stopped unexpectedly.",
};

/**
 * Mints a safe error.
 *
 * Takes a code and nothing else — in particular not the caught value. That is
 * the structural reason a provider cannot choose the string a user sees by
 * throwing one.
 */
export function controlError(code: ControlErrorCode): ControlError {
  return { code, message: CONTROL_ERROR_MESSAGES[code] };
}

export type ControlResult<T> = { ok: true; value: T } | { ok: false; error: ControlError };

export function controlFailure<T = never>(code: ControlErrorCode): ControlResult<T> {
  return { ok: false, error: controlError(code) };
}

/** Where a control adapter's connection stands. Mirrors the connector vocabulary deliberately. */
export type ControlConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "unavailable"
  | "configuration_required"
  | "error";

export type ControlStatus = {
  kind: ControlConnectionStatus;
  since: number;
  lastError?: ControlError;
  /** One safe sentence for the states where "why" is the whole question. */
  detail?: string;
};

/** What the adapter is asked to start. Every field is TabDump's vocabulary, not a provider's. */
export type CreateSessionRequest = {
  /** TabDump's session id. The adapter maps it to whatever the provider calls one. */
  sessionId: string;
  /**
   * The authorized project, already validated and already checked against
   * this provider's authorization list. Absent means the session gets no
   * local scope at all.
   */
  project?: AgentProject;
  /** The grant the service already verified. Passed so an adapter can narrow, never widen. */
  permissions: AgentPermissionGrant;
  /** Context to seed the session with. */
  attachments: readonly AgentContextAttachment[];
  title?: string;
};

export type ResumeSessionRequest = {
  sessionId: string;
  /** The provider's own id for the conversation being reattached to. Opaque to everything but the adapter. */
  providerSessionId: string;
  project?: AgentProject;
  permissions: AgentPermissionGrant;
};

/** What an adapter reports back about a session it started or resumed. */
export type SessionHandle = {
  sessionId: string;
  /** The provider's id, once it has one. */
  providerSessionId?: string;
  status: AgentSessionStatus;
};

export type ControlEventListener = (event: AgentControlEvent) => void;
export type ControlStatusListener = (status: ControlStatus) => void;
export type ControlUnsubscribe = () => void;

/**
 * An approval the adapter is asking for, on the provider's behalf.
 *
 * Deliberately *not* the full `AgentApproval`: the adapter supplies what it
 * knows, and the broker mints the record with the id, timestamps and expiry.
 * An adapter that could mint its own approval could mint one that was already
 * granted.
 */
export type AdapterApprovalRequest = {
  sessionId: string;
  runId?: string;
  action: import("./approvals").ApprovalAction;
  scope: import("./permissions").AgentPermissionScope;
  projectId: string;
  targets: readonly string[];
  reason?: string;
};

/**
 * The provider-neutral control contract.
 *
 * Every method returns a `ControlResult`, and an adapter that has not
 * implemented one returns `unsupported` rather than throwing or pretending.
 * That is what makes a half-built adapter safe to register: the registry can
 * hold it, the UI can list it, and nothing can invoke a capability it never
 * declared.
 */
export interface AgentControlAdapter {
  readonly provider: AgentProviderId;

  /** What this adapter implements **today**. See ./capabilities.ts on why there is no roadmap field. */
  getCapabilities(): AgentCapabilitySet;

  getConnectionStatus(): ControlStatus;

  /** Prepares the adapter to drive sessions. Resolves with the status it settled into, including failure. */
  connect(): Promise<ControlResult<ControlStatus>>;

  /** Releases whatever connecting held. Does not end sessions the provider owns. */
  disconnect(): Promise<void>;

  createSession(request: CreateSessionRequest): Promise<ControlResult<SessionHandle>>;

  resumeSession(request: ResumeSessionRequest): Promise<ControlResult<SessionHandle>>;

  /** Delivers a message into a live session. */
  sendMessage(message: AgentMessageInput): Promise<ControlResult<void>>;

  /** Stops the in-flight run without ending the session. */
  cancelRun(sessionId: string): Promise<ControlResult<void>>;

  /**
   * Tells the adapter how an approval was answered.
   *
   * The adapter never *decides* an approval — it is told. `requestApproval`
   * is deliberately not a method here: an adapter raises one by emitting an
   * `approval_requested` event through its own event stream, and the service
   * routes it to the broker. An adapter that could call into the broker
   * directly could route around it.
   */
  respondToApproval(
    approvalId: string,
    decision: "granted" | "denied"
  ): Promise<ControlResult<void>>;

  /** Receives normalized events. Returns the detach function. */
  subscribeToEvents(listener: ControlEventListener): ControlUnsubscribe;

  /** Receives connection status changes. Returns the detach function. */
  watchStatus(listener: ControlStatusListener): ControlUnsubscribe;

  /** Final teardown. Idempotent. */
  dispose(): void;
}

/**
 * Whether an adapter declares a capability.
 *
 * A free function rather than a method so that the check has one
 * implementation that an adapter cannot override to say yes.
 */
export function adapterSupports(
  adapter: AgentControlAdapter,
  capability: AgentCapability
): boolean {
  return adapter.getCapabilities().has(capability);
}
