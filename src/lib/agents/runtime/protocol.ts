import { isAgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentCapability } from "@/lib/agents/control/capabilities";
import type { AgentAttachedContext } from "@/lib/agents/control/context";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import { readSessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import type { SessionContextCapability } from "@/lib/agents/session-context/capabilities";
import type { WorkspaceChangeSummary } from "@/lib/agents/session-context/changes";
import type { WorkspacePlanPreview } from "@/lib/agents/session-context/plan";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";

/**
 * The browser to local-runtime command contract.
 *
 * ## What this file is for
 *
 * The browser needs a way to ask the trusted local runtime to do something.
 * This is the entire vocabulary it may use, and the point of writing it as a
 * closed union is that the vocabulary is *small and boring*: eighteen verbs —
 * fourteen control-plane operations the `ControlService` already implements,
 * plus Phase J's four connector-lifecycle verbs (detect, connect, sign in,
 * disconnect) — and not one of them able to name a binary, a command line, a
 * filesystem path, a provider flag or a credential.
 *
 * ## What is deliberately absent
 *
 * There is no `exec`, no `spawn`, no `shell`, no `readFile`, no `writeFile`,
 * no `listDirectory` and no passthrough. A command that could carry an
 * arbitrary provider option would make this a general-purpose process
 * launcher wearing a typed hat - the guard suite asserts that no such member
 * exists, and the union being closed is what makes that assertion possible to
 * write at all.
 *
 * The one place a caller-supplied *path-like* value could enter is a project,
 * and it cannot: a command names a project by **id**. The runtime resolves
 * that id against projects the user authorized, and a caller that invents an
 * id gets `project_scope_violation` rather than a directory. The brief's
 * "do not trust a client-supplied project root" is enforced by the type,
 * not by a check.
 *
 * ## Why this module is pure
 *
 * It is imported by the browser client, by the route handler and by the host.
 * It reaches for no global, imports nothing from Node, and does no I/O, so
 * the same definitions are true on both sides of the boundary and a mismatch
 * is a type error rather than a runtime surprise.
 */

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Why a runtime command did not happen.
 *
 * A closed code plus a message from the fixed table below - the same
 * discipline `ControlError` and `ConnectorError` already follow, for the same
 * reason: an error is the easiest path for a provider string, an environment
 * variable or a filesystem path to reach a screen, and the only way to be
 * certain it cannot is to have nowhere to put one.
 *
 * Distinct from `ControlErrorCode` rather than reusing it. The control plane
 * answers "why did the *operation* fail"; this answers "why did the
 * *request* fail", and three of these - `runtime_disconnected`,
 * `ownership_denied`, `runtime_unavailable` - have no control-plane meaning
 * because they are decided before a control operation is ever attempted.
 */
export type RuntimeErrorCode =
  /** This deployment may not execute agents. See lib/agents/control/runtime.ts. */
  | "runtime_unavailable"
  /** The host this client was talking to is gone - a restart, or a different process. */
  | "runtime_disconnected"
  /** The request did not come from this TabDump instance. */
  | "ownership_denied"
  /** No adapter for this provider, or it is not registered here. */
  | "provider_unavailable"
  /** The provider needs credentials the user has not supplied. */
  | "authentication_required"
  /** No such session, or it belongs to somebody else. */
  | "session_not_found"
  /** The session is in a status that cannot accept this. */
  | "invalid_session_state"
  /** The grant does not cover what this command needs. */
  | "permission_denied"
  /** An approval is outstanding and must be answered first. */
  | "approval_required"
  /** The named project is unknown, or this provider is not authorized for it. */
  | "project_scope_violation"
  /** The attached context was malformed. */
  | "context_invalid"
  /** The provider itself failed. */
  | "provider_error"
  /** The run was cancelled. */
  | "cancellation"
  /** The provider did not answer in time. */
  | "timeout"
  /** The command did not parse, or named something this runtime does not do. */
  | "invalid_request"
  /** The adapter does not implement this. */
  | "unsupported"
  /** The agent would not work in a mode where it asks TabDump before acting. */
  | "approval_unenforceable";

export const RUNTIME_ERROR_CODES: readonly RuntimeErrorCode[] = [
  "runtime_unavailable",
  "runtime_disconnected",
  "ownership_denied",
  "provider_unavailable",
  "authentication_required",
  "session_not_found",
  "invalid_session_state",
  "permission_denied",
  "approval_required",
  "project_scope_violation",
  "context_invalid",
  "provider_error",
  "cancellation",
  "timeout",
  "invalid_request",
  "unsupported",
  "approval_unenforceable",
] as const;

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return typeof value === "string" && (RUNTIME_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The sentence a UI shows.
 *
 * Every one is written for a person and mentions nothing about the machine it
 * is running on: no path, no port, no environment variable name, no provider
 * error text. A user who needs to know *how* to enable local execution reads
 * the documentation; an error message that named the variable would put the
 * shape of the opt-in on any screen a hosted deployment could render.
 */
const RUNTIME_ERROR_MESSAGES: Record<RuntimeErrorCode, string> = {
  runtime_unavailable: "TabDump cannot run agents in this environment.",
  runtime_disconnected: "TabDump lost its connection to the local runtime.",
  ownership_denied: "That session belongs to someone else.",
  provider_unavailable: "That agent is not available here.",
  authentication_required: "That agent needs to be signed in first.",
  session_not_found: "That session no longer exists.",
  invalid_session_state: "That session cannot accept this right now.",
  permission_denied: "This agent has not been given permission for that.",
  approval_required: "That needs your approval first.",
  project_scope_violation: "This agent is not authorized for that project.",
  context_invalid: "TabDump could not read that context.",
  provider_error: "The agent stopped unexpectedly.",
  cancellation: "The run was cancelled.",
  timeout: "The agent did not respond in time.",
  invalid_request: "TabDump could not read that request.",
  unsupported: "This agent cannot do that yet.",
  approval_unenforceable: "That agent would not agree to ask before acting.",
};

export type RuntimeError = { code: RuntimeErrorCode; message: string };

/** Mints a safe error. Takes a code and nothing else, so nothing can be interpolated into it. */
export function runtimeError(code: RuntimeErrorCode): RuntimeError {
  return { code, message: RUNTIME_ERROR_MESSAGES[code] };
}

export type RuntimeResult<T> = { ok: true; value: T } | { ok: false; error: RuntimeError };

export function runtimeFailure<T = never>(code: RuntimeErrorCode): RuntimeResult<T> {
  return { ok: false, error: runtimeError(code) };
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * Where the runtime believes it is, in the terms the brief asks for.
 *
 * A projection of `RuntimeDecision` (lib/agents/control/runtime.ts) rather
 * than a second decision: `local-desktop` and `local-server` both project to
 * `local`, because the difference matters to the host and not to a UI asking
 * "can I use this". `unknown` is kept distinct from `hosted` for the opposite
 * reason - they behave identically and *read* differently, and a UI that said
 * "this is a hosted deployment" to a developer who forgot the opt-in would be
 * lying about their machine.
 *
 * `remote` is an *executing* kind, and the only one that does not mean "this
 * machine". It says agents run here and none of them can see the filesystem
 * of the process reporting it - which is a different sentence from `hosted`,
 * where nothing runs at all.
 */
export type RuntimeEnvironmentKind = "browser" | "local" | "remote" | "hosted" | "unknown";

/**
 * What a provider's connection actually is, kept as three separate facts.
 *
 * *Available*, *authenticated* and *capable* must not collapse into one
 * boolean, and they do not collapse here.
 *
 *   - `available` - an adapter is registered and its runtime loaded.
 *   - `authentication` - `"unknown"` unless the provider has actually told us.
 *     It is the honest answer almost always: Claude Code authenticates
 *     lazily, so the first proof either way arrives when a run starts.
 *   - `capabilities` - what the adapter declares it implements today.
 */
export type ProviderAuthenticationState = "unknown" | "authenticated" | "required";

export type RuntimeProviderStatus = {
  provider: AgentProviderId;
  connection:
    | "unavailable"
    | "disconnected"
    | "connecting"
    | "connected"
    | "configuration_required"
    | "error";
  available: boolean;
  authentication: ProviderAuthenticationState;
  capabilities: readonly AgentCapability[];
  /**
   * The agent signs in with its **own** login, which this runtime can start
   * (`authenticate_provider`) — rather than with a key the user stores in
   * TabDump. True for the ACP agents everywhere, and for Claude Code in the
   * desktop app (Phase J.1). Absent means false.
   */
  nativeSignIn?: boolean;
};

/**
 * The safe status object a UI may hold.
 *
 * The brief lists what must not be here, and none of it is: no API key, no
 * OAuth token, no environment variable (name or value), no filesystem path,
 * no command line, no home directory, no port. `security.test.ts` asserts
 * that the whole reply of a `get_status` command contains no such value, on a
 * host deliberately built with secrets in its environment.
 */
export type RuntimeStatus = {
  environment: RuntimeEnvironmentKind;
  /** Whether a provider could be executed here at all. */
  executable: boolean;
  /**
   * This host process's identity.
   *
   * **Not a secret and not an authenticator.** It changes every time the
   * process starts, which is exactly its job: a client that comes back after
   * a restart carrying the old one is told `runtime_disconnected` rather than
   * quietly getting a second, empty world. See ./host.ts on why this is a
   * generation guard rather than a credential.
   */
  runtimeId: string;
  /** Present only when execution is refused. One safe sentence. */
  detail?: string;
  providers: readonly RuntimeProviderStatus[];
};

/* ------------------------------------------------------------------ *
 * Provider connection (Phase J)
 * ------------------------------------------------------------------ */

/**
 * What is installed on the machine the runtime runs on, per provider.
 *
 * Only ever produced by a **local** runtime: a hosted or remote deployment's
 * binaries are not the user's, and reporting them would be both meaningless
 * and a leak. Carries no path — `installed` and `launchable` are booleans on
 * purpose.
 *
 * Nothing about sign-in: that is reported by the agent itself, through
 * `connect_provider` (`RuntimeProviderStatus.authentication`), never guessed
 * from what files exist (Phase J.2).
 */
export type ProviderDetection = {
  provider: AgentProviderId;
  installed: boolean;
  /** How TabDump drives it: the provider SDK, or the Agent Client Protocol. */
  transport: "sdk" | "acp";
  /** Whether the executable TabDump would start was found. */
  launchable: boolean;
};

/** A sign-in method the agent itself advertised. Labels only. */
export type ProviderAuthMethodView = { id: string; name: string; description?: string };

/**
 * One provider's connection, as the runtime sees it after a connect or a
 * sign-in. The same three facts `RuntimeProviderStatus` keeps apart, plus the
 * agent's own sign-in methods.
 */
export type ProviderConnectionView = RuntimeProviderStatus & {
  authMethods: readonly ProviderAuthMethodView[];
};

/* ------------------------------------------------------------------ *
 * Session views
 * ------------------------------------------------------------------ */

/**
 * One live session, as the runtime describes it to a client.
 *
 * Everything the future command centre's questions need, and nothing more.
 * Note in particular what is *not* here: no transcript, no grant, no project
 * path, no context contents. A client that wants to know what the agent was
 * told reads the snapshot it attached; a client that wants to know what the
 * agent may do reads the project it authorized.
 */
export type RuntimeSessionView = {
  sessionId: string;
  provider: AgentProviderId;
  status: AgentSessionStatus;
  /** The provider's own id, once it has revealed one. Opaque; never parsed. */
  providerSessionId?: string;
  projectId?: string;
  workspaceId?: string;
  title?: string;
  /** The context snapshot currently attached, by the bridge's id. */
  contextSnapshotId?: string;
  /** Every control run this session has produced, oldest first. */
  runIds: readonly string[];
  /** The run currently in flight, if any. */
  activeRunId?: string;
  /** Whether an approval is outstanding. */
  awaitingApproval: boolean;
  /** Whether `cancel_run` would reach a provider. */
  cancellable: boolean;
  /** Whether this session could be reattached to after a restart. */
  resumable: boolean;
  /** The highest event sequence this session has emitted. A cursor for reconnects. */
  latestSequence: number;
  createdAt: number;
  updatedAt: number;
  /** The session's TabDump workspace context, when it has one (Phase J.3). */
  context?: RuntimeSessionContextView;
  /**
   * Set when the session was started from a workspace but has no context
   * (J.4): its agent cannot prove which of its tool calls are TabDump's, so
   * it was not given the context server. Never set alongside `context`.
   */
  contextUnavailable?: "provider";
};

/**
 * What a client may know about a session's workspace context (Phase J.3).
 *
 * The workspace, what the agent may do in it, and the approved changes
 * waiting for the Command Centre to apply. **Never the credential**: there is
 * no field here, or anywhere in this protocol, that could carry it.
 */
export type RuntimeSessionContextView = {
  workspaceId: string;
  workspaceName: string;
  capabilities: readonly SessionContextCapability[];
  /** Monotonic context version (J.4): 1 at start, +1 per synced change. */
  version: number;
  /** When the runtime last accepted a snapshot. */
  syncedAt: number;
  /**
   * `snapshotFingerprint` of what the runtime holds. The Command Centre
   * compares it with its own to show "Update available" — nothing is sent.
   */
  fingerprint: string;
  /** Changes the user approved, for the Command Centre — which owns the workspace — to apply. */
  pendingActions: readonly RuntimeContextActionView[];
  /**
   * How this session's recent plans ended (J.5), oldest first, for the
   * result line under the approval. Absent when there are none.
   */
  planOutcomes?: readonly RuntimePlanOutcomeView[];
};

/** One operation of an approved plan, exactly as the Command Centre applies it (J.5). */
export type RuntimePlanOperationView =
  | { kind: "create_collection"; name: string; tabIds: readonly string[] }
  | { kind: "rename_collection"; collectionId: string; name: string }
  | { kind: "add_tabs_to_collection"; collectionId: string; tabIds: readonly string[] };

/** An approved change, exactly as the Command Centre applies it (J.3–J.4) — or an approved plan, applied all at once (J.5). */
export type RuntimeContextActionView =
  | { actionId: string; kind: "create_collection"; name: string; tabIds: readonly string[] }
  | { actionId: string; kind: "rename_collection"; collectionId: string; name: string }
  | { actionId: string; kind: "add_tabs_to_collection"; collectionId: string; tabIds: readonly string[] }
  | {
      actionId: string;
      kind: "apply_plan";
      planId: string;
      /** Echoed back on completion; any other value is refused. Not a secret — a binding. */
      planHash: string;
      operations: readonly RuntimePlanOperationView[];
    };

/** What became of a plan (J.5). Counts and a version; the approval it answered, when known. */
export type RuntimePlanOutcomeView = {
  planId: string;
  approvalId?: string;
  status: "applied" | "unverified" | "not_applied" | "stale" | "denied" | "expired" | "cancelled";
  operationCount: number;
  verifiedCount: number;
  contextVersion: number;
  at: number;
};

/**
 * One event, with the ordering the wire needs.
 *
 * `sequence` is assigned by the host, not by an adapter and not by a
 * provider - see ./journal.ts on why a timestamp is not an order.
 */
export type SequencedControlEvent = AgentControlEvent & { sequence: number };

/**
 * What joins a control run to observed provider activity.
 *
 * Deliberately every field optional but `provider` and `origin`: the whole
 * point of the correlation layer is that *both* halves exist independently. A
 * session TabDump started has a `controlRunId` before it has a
 * `providerSessionId`; a session somebody started in a terminal has a
 * `providerSessionId` and an `observationRunId` and never gets a
 * `controlRunId`. See ./correlation.ts.
 */
export type RuntimeCorrelationView = {
  provider: AgentProviderId;
  controlSessionId?: string;
  controlRunId?: string;
  providerSessionId?: string;
  observationAgentId?: string;
  observationRunId?: string;
  /** Which plane first produced this record. */
  origin: "control" | "observation";
  firstSeenAt: number;
  updatedAt: number;
};

/**
 * A project record as it crosses the boundary, before validation.
 *
 * Structurally `AgentProject` minus its timestamps, which the host sets
 * itself - a client-supplied `createdAt` would be a value nothing checks and
 * everything displays. `permissions` is the grant the user made when they
 * authorized the directory; the host revalidates it with `isValidGrant` and
 * drops the project rather than the grant if it does not hold, because a
 * project whose grant silently became "nothing" would look authorized and
 * refuse everything.
 */
export type AuthorizedProjectInput = {
  id: string;
  name: string;
  path: string;
  providers: readonly AgentProviderId[];
  additionalDirectories?: readonly string[];
  permissions: { scopes: readonly string[]; projectId?: string; grantedAt: number };
};

/** What the host made of an `authorize_projects` command. */
export type AuthorizedProjectsResult = {
  /** Ids the host now recognises. */
  accepted: readonly string[];
  /** Ids it refused, with the reason the validator gave. */
  rejected: readonly { id: string; reason: string }[];
};

/** An approval waiting on the user, as the runtime describes it. */
export type RuntimeApprovalView = {
  approvalId: string;
  sessionId: string;
  /** Which agent is asking, so the card can say so (J.4). */
  provider: AgentProviderId;
  runId?: string;
  action: string;
  scope: string;
  /** Exactly one of these: a project for file and command actions, a workspace for workspace changes (J.3). */
  projectId?: string;
  workspaceId?: string;
  /** Project-relative paths, or plain descriptions of a workspace change. Never absolute. */
  targets: readonly string[];
  reason?: string;
  /** A workspace change, structured for the card (J.4). Names and titles only — never ids. */
  change?: WorkspaceChangeSummary;
  /** A plan of workspace changes (J.5): every step the user is approving, as one immutable whole. */
  plan?: WorkspacePlanPreview;
  requestedAt: number;
  expiresAt: number;
};

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * Every verb the browser may use. Adding a nineteenth is a type error in the
 * host, in the client and in the guard suite at once.
 */
export type RuntimeCommandName =
  | "get_status"
  | "list_sessions"
  | "get_session"
  | "get_events"
  | "authorize_projects"
  | "create_session"
  | "resume_session"
  | "send_message"
  | "cancel_run"
  | "attach_context"
  | "detach_context"
  | "respond_to_approval"
  | "dispose_session"
  | "link_observation"
  /* Phase J — the connector lifecycle. None names a binary or a path. */
  | "detect_providers"
  | "connect_provider"
  | "authenticate_provider"
  | "disconnect_provider"
  /* Phase J.3 — session workspace context. Neither names a credential. */
  | "sync_session_context"
  | "complete_context_action";

export const RUNTIME_COMMAND_NAMES: readonly RuntimeCommandName[] = [
  "get_status",
  "list_sessions",
  "get_session",
  "get_events",
  "authorize_projects",
  "create_session",
  "resume_session",
  "send_message",
  "cancel_run",
  "attach_context",
  "detach_context",
  "respond_to_approval",
  "dispose_session",
  "link_observation",
  "detect_providers",
  "connect_provider",
  "authenticate_provider",
  "disconnect_provider",
  "sync_session_context",
  "complete_context_action",
] as const;

export function isRuntimeCommandName(value: unknown): value is RuntimeCommandName {
  return (
    typeof value === "string" && (RUNTIME_COMMAND_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Commands that do not require the caller to already know the host's
 * identity.
 *
 * Only `get_status` - which is how a client *learns* it. Everything else must
 * name the runtime it thinks it is talking to, so a client holding a handle
 * from before a restart is refused rather than silently served.
 */
export const RUNTIME_HANDSHAKE_COMMANDS: readonly RuntimeCommandName[] = ["get_status"] as const;

export function isHandshakeCommand(name: RuntimeCommandName): boolean {
  return (RUNTIME_HANDSHAKE_COMMANDS as readonly string[]).includes(name);
}

export type RuntimeCommand =
  | { name: "get_status" }
  | { name: "list_sessions" }
  | { name: "get_session"; sessionId: string }
  | { name: "get_events"; sessionId: string; afterSequence?: number }
  /**
   * Tells the runtime which projects this actor has authorized.
   *
   * ## Why this exists, and what it honestly is
   *
   * A project is the only thing in this protocol that ultimately resolves to
   * a directory, and every other command names one by **id**. But the
   * durable project record lives in the browser - TabDump is local-first,
   * and `lib/agents/control/persistence.ts` is where projects are kept - so
   * the host has to be told about one before an id can mean anything.
   *
   * The host does not *trust* what arrives. Every path is put back through
   * `validateProjectPath` and `createProject`, which reject filesystem roots,
   * home directories, unresolved and traversing paths, exactly as they did
   * when the project was first created and again when it was loaded from
   * storage. A record that fails is dropped and named in the reply rather
   * than silently accepted.
   *
   * What that buys, precisely: a caller cannot widen a project into somewhere
   * the validator refuses, cannot grant itself scopes the grant model calls
   * incoherent, and cannot reach another actor's projects. What it does *not*
   * buy: a guarantee that the path is one the user pointed at, because a
   * browser-served runtime has no trusted path source to compare it against.
   * The thing that would provide one is a native folder picker in the desktop
   * shell, and it is named in docs/agent-local-runtime.md as the next step
   * rather than pretended to here.
   *
   * Replaces the actor's whole set rather than merging. A project the user
   * revoked must disappear from the runtime on the next sync, and a merge
   * would leave it authorized until the process restarted.
   */
  | { name: "authorize_projects"; projects: readonly AuthorizedProjectInput[] }
  | {
      name: "create_session";
      provider: AgentProviderId;
      /** By **id**. A path can never cross this boundary. */
      projectId?: string;
      workspaceId?: string;
      title?: string;
      /** Already resolved by the context bridge. Validated again on arrival. */
      context?: AgentAttachedContext;
      /**
       * The workspace the session is started from, for the agent to query
       * (J.3) — bounded, and only ever of `workspaceId`. What the agent may do
       * with it is decided by the runtime from the session's grant, not asked
       * for here.
       */
      contextSnapshot?: SessionContextSnapshot;
    }
  | {
      name: "resume_session";
      provider: AgentProviderId;
      providerSessionId: string;
      projectId?: string;
      workspaceId?: string;
      title?: string;
    }
  | { name: "send_message"; sessionId: string; text: string; context?: AgentAttachedContext }
  | { name: "cancel_run"; sessionId: string }
  | { name: "attach_context"; sessionId: string; context: AgentAttachedContext }
  | { name: "detach_context"; sessionId: string }
  | { name: "respond_to_approval"; approvalId: string; decision: "granted" | "denied" }
  | { name: "dispose_session"; sessionId: string }
  | {
      name: "link_observation";
      sessionId: string;
      observationAgentId: string;
      observationRunId: string;
    }
  /** What is installed on this machine. A local runtime only; empty elsewhere. */
  | { name: "detect_providers" }
  /** Proves the agent can be reached and learns how it signs in. Starts no session. */
  | { name: "connect_provider"; provider: AgentProviderId }
  /**
   * Runs the agent's **own** sign-in for a method it advertised.
   *
   * A method id and nothing else: there is no field here a key, a token or a
   * password could be put in, so no credential can cross this boundary.
   */
  | { name: "authenticate_provider"; provider: AgentProviderId; methodId: string }
  /** Ends this actor's sessions with the provider and releases its connection. */
  | { name: "disconnect_provider"; provider: AgentProviderId }
  /** A fresher copy of the session's own workspace. Refused for any other workspace. */
  | { name: "sync_session_context"; sessionId: string; snapshot: SessionContextSnapshot }
  /**
   * The Command Centre applied (or could not apply) a change the user
   * approved. Only an approved action of this session can be completed. A
   * plan (J.5) is answered with its hash and the ids it created, in order —
   * or, when it could not be applied, the operation that no longer fit.
   */
  | {
      name: "complete_context_action";
      sessionId: string;
      actionId: string;
      outcome:
        | { ok: true; collectionId: string }
        | { ok: true; planHash: string; created: readonly string[] }
        | { ok: false; failedAt?: number };
    };

/** What each command answers with. Keyed by name so the client can type one call generically. */
export type RuntimeCommandResults = {
  get_status: RuntimeStatus;
  list_sessions: {
    sessions: readonly RuntimeSessionView[];
    correlations: readonly RuntimeCorrelationView[];
  };
  get_session: { session: RuntimeSessionView; approvals: readonly RuntimeApprovalView[] };
  get_events: { events: readonly SequencedControlEvent[]; latestSequence: number };
  authorize_projects: AuthorizedProjectsResult;
  create_session: RuntimeSessionView;
  resume_session: RuntimeSessionView;
  send_message: RuntimeSessionView;
  cancel_run: RuntimeSessionView;
  attach_context: RuntimeSessionView;
  detach_context: RuntimeSessionView;
  respond_to_approval: RuntimeSessionView;
  dispose_session: { sessionId: string };
  sync_session_context: { sessionId: string; version: number };
  complete_context_action: { sessionId: string };
  link_observation: RuntimeCorrelationView;
  detect_providers: {
    /** `false` on any runtime that is not the user's own machine. */
    thisMachine: boolean;
    detections: readonly ProviderDetection[];
  };
  connect_provider: ProviderConnectionView;
  authenticate_provider: ProviderConnectionView;
  disconnect_provider: ProviderConnectionView;
};

export type RuntimeCommandResult<N extends RuntimeCommandName> = RuntimeResult<
  RuntimeCommandResults[N]
>;

/**
 * The wire envelope.
 *
 * `runtimeId` is what the client believes it is talking to, and is absent on
 * the handshake command that discovers it.
 */
export type RuntimeRequest = {
  runtimeId?: string;
  command: RuntimeCommand;
};

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Caps on what a command may carry. Everything crossing this boundary is bounded. */
export const MAX_COMMAND_TEXT_LENGTH = 100_000;
export const MAX_COMMAND_ID_LENGTH = 200;
export const MAX_COMMAND_TITLE_LENGTH = 200;
/** Matches the persistence layer's own cap, so a full local store syncs in one command. */
export const MAX_AUTHORIZED_PROJECTS = 100;
/** Matches `MAX_PROJECT_PATH_LENGTH`. Checked here too so an oversized body never reaches the validator. */
export const MAX_COMMAND_PATH_LENGTH = 4096;
/** Per project. A project reaching more directories than this is not a project. */
export const MAX_ADDITIONAL_DIRECTORIES = 20;

function id(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_ID_LENGTH) return null;
  return trimmed;
}

function optionalId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return id(value);
}

function optionalTitle(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_COMMAND_TITLE_LENGTH ? null : trimmed;
}

/**
 * Whether a value is shaped like an attached context.
 *
 * Structural only. The control plane revalidates it against its own rules -
 * `isWellFormedAttachedContext` - before anything is attached, so this is the
 * cheap "is it even an object" pass that keeps a malformed body from reaching
 * a deeper layer, not the authority on what a valid context is.
 */
function attachedContext(value: unknown): AgentAttachedContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.snapshotId !== "string" || !record.snapshotId) return null;
  if (typeof record.capturedAt !== "number" || !Number.isFinite(record.capturedAt)) return null;
  if (!Array.isArray(record.attachments)) return null;
  return value as AgentAttachedContext;
}

/**
 * Whether a value is shaped like a project record.
 *
 * Shape only, and deliberately so. Whether the *path* is acceptable is a
 * question for `validateProjectPath`, which the host asks - and which knows
 * about filesystem roots, home directories and traversal. Duplicating any of
 * that judgement here would give it two homes, and the one on the wire would
 * be the one that fell behind.
 */
function authorizedProject(value: unknown): AuthorizedProjectInput | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const projectId = id(record.id);
  if (!projectId) return null;

  if (typeof record.name !== "string" || !record.name.trim()) return null;
  if (record.name.length > MAX_COMMAND_TITLE_LENGTH) return null;

  if (typeof record.path !== "string" || !record.path.trim()) return null;
  if (record.path.length > MAX_COMMAND_PATH_LENGTH) return null;

  if (!Array.isArray(record.providers)) return null;
  if (!record.providers.every(isAgentProviderId)) return null;

  const additional: string[] = [];
  if (record.additionalDirectories !== undefined) {
    if (!Array.isArray(record.additionalDirectories)) return null;
    if (record.additionalDirectories.length > MAX_ADDITIONAL_DIRECTORIES) return null;
    for (const entry of record.additionalDirectories) {
      if (typeof entry !== "string" || !entry.trim()) return null;
      if (entry.length > MAX_COMMAND_PATH_LENGTH) return null;
      additional.push(entry);
    }
  }

  const permissions = record.permissions;
  if (!permissions || typeof permissions !== "object") return null;
  const grant = permissions as Record<string, unknown>;
  if (!Array.isArray(grant.scopes)) return null;
  if (!grant.scopes.every((scope) => typeof scope === "string")) return null;
  if (typeof grant.grantedAt !== "number" || !Number.isFinite(grant.grantedAt)) return null;

  const grantProjectId = optionalId(grant.projectId);
  if (grantProjectId === null) return null;

  return {
    id: projectId,
    name: record.name.trim(),
    path: record.path,
    providers: record.providers,
    additionalDirectories: additional,
    permissions: {
      scopes: grant.scopes as readonly string[],
      ...(grantProjectId !== undefined ? { projectId: grantProjectId } : {}),
      grantedAt: grant.grantedAt,
    },
  };
}

/**
 * Parses an untrusted body into a command, or refuses.
 *
 * Every field is checked, and there is no pass-through: a property the union
 * does not name is dropped rather than forwarded, so an extra key in a
 * request body cannot become an extra option on a provider.
 *
 * Returns `null` rather than throwing. The caller turns that into
 * `invalid_request`, which is the only thing a malformed body may learn.
 */
export function parseRuntimeRequest(body: unknown): RuntimeRequest | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as Record<string, unknown>;

  const runtimeId = optionalId(envelope.runtimeId);
  if (runtimeId === null) return null;

  const command = parseRuntimeCommand(envelope.command);
  if (!command) return null;

  return runtimeId === undefined ? { command } : { runtimeId, command };
}

export function parseRuntimeCommand(value: unknown): RuntimeCommand | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isRuntimeCommandName(raw.name)) return null;

  switch (raw.name) {
    case "get_status":
      return { name: "get_status" };

    case "list_sessions":
      return { name: "list_sessions" };

    case "get_session": {
      const sessionId = id(raw.sessionId);
      return sessionId ? { name: "get_session", sessionId } : null;
    }

    case "get_events": {
      const sessionId = id(raw.sessionId);
      if (!sessionId) return null;
      if (raw.afterSequence === undefined || raw.afterSequence === null) {
        return { name: "get_events", sessionId };
      }
      if (typeof raw.afterSequence !== "number" || !Number.isInteger(raw.afterSequence)) {
        return null;
      }
      if (raw.afterSequence < 0) return null;
      return { name: "get_events", sessionId, afterSequence: raw.afterSequence };
    }

    case "authorize_projects": {
      if (!Array.isArray(raw.projects)) return null;
      if (raw.projects.length > MAX_AUTHORIZED_PROJECTS) return null;

      const projects: AuthorizedProjectInput[] = [];
      for (const candidate of raw.projects) {
        const project = authorizedProject(candidate);
        // Structural failure refuses the whole command rather than skipping
        // one entry. A body this malformed is a bug in the caller, and
        // half-applying it would leave the runtime's idea of what is
        // authorized quietly different from the browser's. A project that
        // parses but fails *validation* is a different matter, and the host
        // reports that one individually.
        if (!project) return null;
        projects.push(project);
      }

      return { name: "authorize_projects", projects };
    }

    case "create_session": {
      if (!isAgentProviderId(raw.provider)) return null;

      const projectId = optionalId(raw.projectId);
      if (projectId === null) return null;
      const workspaceId = optionalId(raw.workspaceId);
      if (workspaceId === null) return null;
      const title = optionalTitle(raw.title);
      if (title === null) return null;

      const command: Extract<RuntimeCommand, { name: "create_session" }> = {
        name: "create_session",
        provider: raw.provider,
      };
      if (projectId !== undefined) command.projectId = projectId;
      if (workspaceId !== undefined) command.workspaceId = workspaceId;
      if (title !== undefined) command.title = title;

      if (raw.context !== undefined && raw.context !== null) {
        const context = attachedContext(raw.context);
        if (!context) return null;
        command.context = context;
      }

      if (raw.contextSnapshot !== undefined && raw.contextSnapshot !== null) {
        // Only ever of the workspace the session is started from.
        if (!workspaceId) return null;
        const snapshot = readSessionContextSnapshot(raw.contextSnapshot, workspaceId);
        if (!snapshot) return null;
        command.contextSnapshot = snapshot;
      }

      return command;
    }

    case "resume_session": {
      if (!isAgentProviderId(raw.provider)) return null;
      const providerSessionId = id(raw.providerSessionId);
      if (!providerSessionId) return null;

      const projectId = optionalId(raw.projectId);
      if (projectId === null) return null;
      const workspaceId = optionalId(raw.workspaceId);
      if (workspaceId === null) return null;
      const title = optionalTitle(raw.title);
      if (title === null) return null;

      const command: Extract<RuntimeCommand, { name: "resume_session" }> = {
        name: "resume_session",
        provider: raw.provider,
        providerSessionId,
      };
      if (projectId !== undefined) command.projectId = projectId;
      if (workspaceId !== undefined) command.workspaceId = workspaceId;
      if (title !== undefined) command.title = title;
      return command;
    }

    case "send_message": {
      const sessionId = id(raw.sessionId);
      if (!sessionId) return null;
      if (typeof raw.text !== "string") return null;
      if (!raw.text.trim()) return null;
      if (raw.text.length > MAX_COMMAND_TEXT_LENGTH) return null;

      const command: Extract<RuntimeCommand, { name: "send_message" }> = {
        name: "send_message",
        sessionId,
        text: raw.text,
      };
      if (raw.context !== undefined && raw.context !== null) {
        const context = attachedContext(raw.context);
        if (!context) return null;
        command.context = context;
      }
      return command;
    }

    case "cancel_run": {
      const sessionId = id(raw.sessionId);
      return sessionId ? { name: "cancel_run", sessionId } : null;
    }

    case "attach_context": {
      const sessionId = id(raw.sessionId);
      if (!sessionId) return null;
      const context = attachedContext(raw.context);
      return context ? { name: "attach_context", sessionId, context } : null;
    }

    case "detach_context": {
      const sessionId = id(raw.sessionId);
      return sessionId ? { name: "detach_context", sessionId } : null;
    }

    case "respond_to_approval": {
      const approvalId = id(raw.approvalId);
      if (!approvalId) return null;
      if (raw.decision !== "granted" && raw.decision !== "denied") return null;
      return { name: "respond_to_approval", approvalId, decision: raw.decision };
    }

    case "dispose_session": {
      const sessionId = id(raw.sessionId);
      return sessionId ? { name: "dispose_session", sessionId } : null;
    }

    case "link_observation": {
      const sessionId = id(raw.sessionId);
      const observationAgentId = id(raw.observationAgentId);
      const observationRunId = id(raw.observationRunId);
      if (!sessionId || !observationAgentId || !observationRunId) return null;
      return { name: "link_observation", sessionId, observationAgentId, observationRunId };
    }

    case "detect_providers":
      return { name: "detect_providers" };

    case "connect_provider":
    case "disconnect_provider":
      return isAgentProviderId(raw.provider) ? { name: raw.name, provider: raw.provider } : null;

    case "authenticate_provider": {
      if (!isAgentProviderId(raw.provider)) return null;
      const methodId = id(raw.methodId);
      return methodId ? { name: "authenticate_provider", provider: raw.provider, methodId } : null;
    }

    case "sync_session_context": {
      const sessionId = id(raw.sessionId);
      const workspace = (raw.snapshot as { workspace?: { id?: unknown } } | null | undefined)?.workspace;
      const workspaceId = id(workspace?.id);
      if (!sessionId || !workspaceId) return null;
      // Shape-checked here; the host re-reads it against the session's own
      // workspace and refuses any other.
      const snapshot = readSessionContextSnapshot(raw.snapshot, workspaceId);
      return snapshot ? { name: "sync_session_context", sessionId, snapshot } : null;
    }

    case "complete_context_action": {
      const sessionId = id(raw.sessionId);
      const actionId = id(raw.actionId);
      const outcome = raw.outcome as
        | { ok?: unknown; collectionId?: unknown; planHash?: unknown; created?: unknown; failedAt?: unknown }
        | null
        | undefined;
      if (!sessionId || !actionId || !outcome || typeof outcome !== "object") return null;
      if (outcome.ok === true && outcome.planHash !== undefined) {
        // A plan (J.5): its hash, and the id of each collection it created, in order.
        const planHash = id(outcome.planHash);
        if (!planHash || !Array.isArray(outcome.created) || outcome.created.length > 20) return null;
        const created = outcome.created.map(id);
        if (created.some((entry) => !entry)) return null;
        return { name: "complete_context_action", sessionId, actionId, outcome: { ok: true, planHash, created: created as string[] } };
      }
      if (outcome.ok === true) {
        const collectionId = id(outcome.collectionId);
        return collectionId
          ? { name: "complete_context_action", sessionId, actionId, outcome: { ok: true, collectionId } }
          : null;
      }
      if (outcome.ok !== false) return null;
      const failedAt =
        typeof outcome.failedAt === "number" && Number.isInteger(outcome.failedAt) && outcome.failedAt >= 0 && outcome.failedAt < 20
          ? { failedAt: outcome.failedAt }
          : {};
      return { name: "complete_context_action", sessionId, actionId, outcome: { ok: false, ...failedAt } };
    }
  }
}
