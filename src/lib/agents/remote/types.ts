import type { AgentPermissionScope } from "@/lib/agents/control/permissions";
import type { AgentProjectSource } from "@/lib/agents/control/projects";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The remote execution plane's own records.
 *
 * ## What lives here and what deliberately does not
 *
 * This module describes the two things a serverless control plane cannot
 * keep in memory: **which sandbox backs which project**, and **which sandbox
 * backs which live session**. Everything else about a session — its status,
 * its runs, its approvals, its events — already has a home in the control
 * plane and the runtime host, and is not duplicated here. A second session
 * model would be a second answer to "is this agent running", and the two
 * would disagree.
 *
 * ## Why these records are server-only, always
 *
 * A `RemoteProject` carries `sandboxName`, which is the handle that addresses
 * a running microVM. It is minted server-side from a CSPRNG, it is never put
 * on the wire, and no command in `runtime/protocol.ts` has a field that could
 * carry one back. The browser's entire vocabulary for a remote project is its
 * `projectId`; the server resolves that to a row, checks the owner, and only
 * then knows a sandbox name.
 *
 * That is the same shape the local plane already uses for paths — a client
 * names a project, never a directory — and it is enforced the same way: by
 * the protocol having nowhere to put the other thing.
 */

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Where a sandbox is in its life.
 *
 * ## Why this is not the session's status
 *
 * A sandbox is infrastructure and a session is a conversation, and they fail
 * independently: a sandbox can be `ready` with no session in it, and a
 * session can be `waiting_for_approval` inside a sandbox that is about to
 * expire. Folding them into one union would force a single field to answer
 * two questions, and the answer it gave would be wrong for one of them.
 *
 * `AgentSessionStatus` continues to say what the agent is doing. This says
 * whether there is anywhere for it to do it.
 */
export type RemoteSandboxStatus =
  /** Requested, not yet usable. Nothing may be dispatched into it. */
  | "creating"
  /** Exists, is warm, and holds the project's files. No agent is running. */
  | "ready"
  /** An agent process is live inside it. */
  | "running"
  /** Teardown has been asked for. Still addressable, but nothing new may start. */
  | "stopping"
  /**
   * Deliberately stopped. Its filesystem was snapshotted, so it can be
   * resumed — but only through explicit lifecycle logic, never by a command
   * that happens to name it.
   */
  | "stopped"
  /**
   * Past its deadline. The platform has reclaimed it.
   *
   * Distinct from `stopped` because the user did not ask for it, which
   * changes what the UI should say and whether resuming is a surprise.
   */
  | "expired"
  /** Creation or execution failed. Not reusable; a new sandbox is required. */
  | "failed";

export const REMOTE_SANDBOX_STATUSES: readonly RemoteSandboxStatus[] = [
  "creating",
  "ready",
  "running",
  "stopping",
  "stopped",
  "expired",
  "failed",
] as const;

export function isRemoteSandboxStatus(value: unknown): value is RemoteSandboxStatus {
  return (
    typeof value === "string" &&
    (REMOTE_SANDBOX_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Statuses a session may be dispatched into.
 *
 * Narrow on purpose, and checked at the point of use rather than trusted from
 * a stored row: the brief's "a stopped/expired sandbox must not be reused
 * accidentally" is exactly the failure that happens when code reads a status
 * it fetched a minute ago. See `sandbox.ts`, which re-reads the platform's own
 * view before it dispatches anything.
 */
export function isDispatchableStatus(status: RemoteSandboxStatus): boolean {
  return status === "ready" || status === "running";
}

/** Whether this status means the sandbox is gone and a new one is needed. */
export function isDeadStatus(status: RemoteSandboxStatus): boolean {
  return status === "stopped" || status === "expired" || status === "failed";
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

/**
 * A project whose files live in a sandbox TabDump created.
 *
 * Every field is one the remote plane genuinely needs. In particular there is
 * **no credential of any kind** — not an Anthropic key, not a Vercel token,
 * not a git password — and `security.test.ts` fails the build if this type
 * grows one. The provider credential belongs to the process's environment and
 * is read at the moment a sandbox is started; storing a copy beside a project
 * would put it in a database row, a backup, and every log line that ever
 * printed a project.
 */
export type RemoteProject = {
  /** The id the browser uses. Opaque, server-minted, unguessable. */
  id: string;
  /**
   * The actor who owns it, in the runtime host's vocabulary — `account:<id>`.
   *
   * Compared on *every* read. A row is never returned because its id matched;
   * it is returned because its id matched and its owner is the caller. See
   * `store.ts` on why the check is inside the query rather than after it.
   */
  ownerId: string;
  name: string;
  /** Always a remote source. The store refuses to write a `local` one. */
  source: Extract<AgentProjectSource, "remote_upload" | "remote_git">;
  /**
   * The platform's handle on the microVM.
   *
   * **Never crosses the wire.** Minted from `crypto.randomUUID`, so it is not
   * derived from the project id, the owner or the name — a leaked project id
   * therefore reveals nothing about how to address the sandbox, and a sandbox
   * name observed anywhere cannot be reversed into an account.
   */
  sandboxName: string;
  /**
   * What the user authorized this project's agents to do.
   *
   * Stored, not assumed. The temptation on the remote plane is to hand every
   * project a full grant on the grounds that the blast radius is a disposable
   * microVM — and that is exactly the reasoning the permission model exists to
   * refuse. A sandbox still runs commands, still reaches the network, and
   * still contains whatever the user uploaded; "it is isolated" is a statement
   * about who *else* is safe, not about whether this user consented.
   *
   * So a remote project's grant is made the same way a local one's is: chosen
   * at creation, stored, and re-read on every dispatch. It is never widened by
   * context, never inferred from the source, and never defaulted to "all".
   */
  scopes: readonly AgentPermissionScope[];
  status: RemoteSandboxStatus;
  /**
   * When the platform will reclaim the sandbox, as it last told us.
   *
   * A cache of the platform's answer, not the authority on it — `sandbox.ts`
   * re-reads before dispatching. Held so the UI can say "expires in 4
   * minutes" without a round trip per render.
   */
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * One live agent session inside a sandbox.
 *
 * The bridge between the host's in-memory session id and the two durable
 * handles needed to reach the agent again from a different serverless
 * invocation: which sandbox, and which process inside it.
 */
export type RemoteSession = {
  /** The control session id. Minted by the control service, as always. */
  id: string;
  ownerId: string;
  projectId: string;
  provider: AgentProviderId;
  sandboxName: string;
  /**
   * The bridge process's command id.
   *
   * What makes a session survive the request that created it: a later
   * invocation calls `getCommand(commandId)` and is talking to the same
   * running agent rather than starting a second one.
   */
  commandId?: string;
  /**
   * The provider's own session id, once the agent has revealed one.
   *
   * Written through from the normal `attachProviderSession` path, so a remote
   * session is resumable on exactly the terms a local one is.
   */
  providerSessionId?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * ## Why there is no event cursor here
 *
 * The obvious design stores a byte offset and drains forward from it. It is
 * wrong for this architecture, and the reason is worth writing down because
 * it is the kind of thing that gets re-added.
 *
 * TabDump's event ordering lives in the runtime host's journal, which is
 * **in memory**. On a serverless control plane that journal is empty at the
 * start of every request. A stored cursor would therefore hand back "events
 * since byte N" to a journal that has no events before byte N — so the
 * client's `afterSequence` cursor would address sequence numbers that this
 * process never assigned, and the stream would have holes.
 *
 * So the sandbox's append-only log *is* the durable journal, and it is
 * replayed from the beginning on every request. The journal assigns the same
 * sequences to the same lines in the same order, deduplicates by event id, and
 * the client's cursor keeps meaning what it always meant.
 *
 * The cost is honest and bounded: one whole-log read and re-normalisation per
 * request, over a log that only lives as long as its sandbox. See
 * docs/agent-remote-runtime.md for when that would stop being acceptable and
 * what the fix would be — a durable journal, not a cursor.
 */

/* ------------------------------------------------------------------ *
 * Workspace layout
 * ------------------------------------------------------------------ */

/**
 * Where a remote project's files live inside its sandbox.
 *
 * A constant, not a parameter. The brief forbids the browser supplying a
 * filesystem path, and the strongest way to honour that is for there to be no
 * variable to supply: every remote project is at the same place in its own
 * private microVM, so there is nothing to choose and nothing to inject.
 *
 * The agent is started with this as its working directory and is given no
 * additional directories, so the scope it sees is the project and not the
 * machine — the same `cwd` discipline the local adapter already applies,
 * reaching a directory TabDump created rather than one a user nominated.
 */
export const REMOTE_WORKSPACE_ROOT = "/workspace/project";

/** Where the bridge reads instructions and writes output. Outside the workspace, so an agent editing its project cannot reach it. */
export const REMOTE_CONTROL_ROOT = "/workspace/.tabdump";
export const REMOTE_INBOX_DIR = `${REMOTE_CONTROL_ROOT}/inbox`;
export const REMOTE_EVENT_LOG = `${REMOTE_CONTROL_ROOT}/events.ndjson`;
export const REMOTE_BRIDGE_PATH = `${REMOTE_CONTROL_ROOT}/agent-bridge.mjs`;

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/**
 * The documented defaults, in one place so they can be read as a policy
 * rather than discovered as magic numbers.
 *
 * Each is a *floor on cost* rather than a guess at what is generous: a remote
 * agent bills for CPU time and egress, and every one of these exists because
 * the alternative is an abandoned sandbox nobody is watching. See
 * docs/agent-remote-runtime.md for the reasoning behind each number.
 */
export const REMOTE_LIMITS = {
  /**
   * How long a sandbox lives without being extended.
   *
   * The platform's own default is five minutes, which is too short for a
   * conversation and too long to leak. Twenty gives a real working session
   * and is still bounded; `extendTimeout` pushes it out while somebody is
   * actually talking to the agent, so an idle one dies on schedule.
   */
  sandboxTimeoutMs: 20 * 60 * 1000,
  /** The ceiling an extension may not push past, however active the session. */
  maxSandboxLifetimeMs: 2 * 60 * 60 * 1000,
  /** Concurrent live sandboxes per account. Refused at creation, never queued silently. */
  maxSandboxesPerOwner: 3,
  /** Live sessions per account across all remote projects. */
  maxSessionsPerOwner: 5,
  /**
   * Total bytes of an uploaded project.
   *
   * Four megabytes, and the number is the platform's rather than a product
   * decision: a serverless function's request body is capped at roughly 4.5MB,
   * so anything larger cannot arrive in one request however generous this
   * constant is. Setting it higher would mean advertising a limit the upload
   * would hit before reaching this check, and failing with a platform error
   * instead of a sentence a user can act on.
   *
   * `multipart/form-data` rather than base64 JSON for the same reason — base64
   * would inflate the payload by a third and cost a quarter of the budget for
   * nothing.
   *
   * Larger projects need staged upload through a blob store, which is a real
   * and separate piece of work. It is named in docs/agent-remote-runtime.md as
   * a seam rather than half-built here.
   */
  maxUploadBytes: 4 * 1024 * 1024,
  /** Files in an uploaded project. A count this high is not a project. */
  maxUploadFiles: 2_000,
  /** Bytes of a single uploaded file. */
  maxUploadFileBytes: 4 * 1024 * 1024,
  /** How much of the event log one drain will read. Bounds a runaway agent's output. */
  maxDrainBytes: 1024 * 1024,
  /** How long the in-sandbox bridge waits for an approval before denying. Fail-closed. */
  approvalTimeoutMs: 10 * 60 * 1000,
  /** vCPUs per sandbox. Two is the platform default and is ample for one agent. */
  vcpus: 2,
} as const;
