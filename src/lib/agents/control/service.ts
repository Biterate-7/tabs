import { readAdapterApprovalDetails } from "./approval-details";
import { createApprovalBroker } from "./approvals";
import { canReattachSession } from "./binding";
import {
  isWellFormedAttachedContext,
  isWellFormedContext,
  isWellFormedMessage,
} from "./context";
import { isWellFormedControlEvent } from "./events";
import { isCapabilityPermitted, NO_PERMISSIONS } from "./permissions";
import { isProviderAuthorized } from "./projects";
import { denyNonServerRuntime } from "./runtime";
import {
  attachContextToSession,
  attachRunToSession,
  createSession as mintSession,
  isTerminalSessionStatus,
  transitionSession,
} from "./session";
import { adapterSupports, controlFailure } from "./types";
import type { ApprovalBroker } from "./approvals";
import type { AgentCapability } from "./capabilities";
import type { AgentAttachedContext, AgentMessageInput } from "./context";
import type { AgentControlEvent } from "./events";
import type { AgentPermissionGrant } from "./permissions";
import type { AgentProject } from "./projects";
import type { RuntimeDecision } from "./runtime";
import type { AgentSession, AgentSessionStatus } from "./session";
import type {
  AgentControlAdapter,
  ControlResult,
  ControlUnsubscribe,
  SessionContextServerEntry,
  SessionHandle,
} from "./types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The control service: the only thing that may drive an adapter.
 *
 * ## Why this exists rather than letting the UI hold an adapter
 *
 * The brief's transport requirement is that a React component must never
 * reach an agent runtime. This is the layer that makes that structural rather
 * than a convention: components get a service, the service holds the
 * adapters, and every path to an adapter runs through the gate below.
 *
 * ## The gate
 *
 * Every operation passes the same checks, in the same order, before an
 * adapter is touched. The order matters — each one is cheaper and broader
 * than the next, and each denies on its own:
 *
 *   1. **Runtime.** May this process execute agents at all? Denied by default.
 *      Checked first because no other check can rescue a `no` here, and
 *      because a hosted deployment must never get far enough to look at a
 *      project path.
 *   2. **Provider registration.** Is there an adapter for this provider?
 *      An unregistered provider cannot execute.
 *   3. **Capability.** Does the adapter *declare* it can do this? An
 *      undeclared capability is refused before dispatch, which is what makes
 *      a half-built adapter safe to register.
 *   4. **Session.** Does the session exist, and is it in a status that can
 *      accept this?
 *   5. **Project authorization.** If the operation has local effects, is
 *      there a project, and is this provider on its list?
 *   6. **Permission.** Does the grant cover the scope this capability needs?
 *
 * Only then is the adapter called. `security.test.ts` asserts that no
 * component directory imports an adapter, and this module's own tests drive
 * each gate independently — a gate that only works because the one before it
 * also fired is a gate that will stop working.
 *
 * ## What it deliberately does not do
 *
 * It does not persist. It does not ingest into the domain. It does not
 * resolve `@workspace` into attachments. Those belong to the layers around
 * it, and folding them in here would make the one security-critical module
 * also the largest one.
 */

export type ControlServiceOptions = {
  /**
   * How the service learns whether local execution is permitted.
   *
   * Injected rather than read, so that the browser bundle has no path to a
   * decision at all: the default denies, and only a caller with a genuine
   * server or desktop context can supply one that allows. Tests drive every
   * branch through it.
   */
  runtime?: () => RuntimeDecision;
  /** Resolves a provider's control adapter. Normally the registry's `control`. */
  resolveAdapter: (provider: AgentProviderId) => AgentControlAdapter | undefined;
  /** Looks up an authorized project. Returning undefined denies, and is the default for an unknown id. */
  resolveProject?: (projectId: string) => AgentProject | undefined;
  broker?: ApprovalBroker;
  now?: () => number;
  /** Mints ids. Injected so tests are deterministic. */
  createId?: () => string;
  /**
   * Told when a session reaches a terminal status, so whatever the caller
   * holds for it — its workspace-context credential — ends with it (J.3).
   */
  onSessionEnded?: (sessionId: string) => void;
};

/** How a workspace approval ended, as the context layer that asked hears it. */
export type WorkspaceApprovalOutcome = "granted" | "denied" | "expired" | "cancelled";

export type StartSessionInput = {
  provider: AgentProviderId;
  projectId?: string;
  workspaceId?: string;
  title?: string;
  /** The grant for this session. Defaults to nothing granted. */
  permissions?: AgentPermissionGrant;
  /**
   * Binds the new session to its workspace context, once its id exists
   * (Phase J.3). Supplied by the runtime per call; the service knows nothing
   * of workspaces beyond carrying the result to the adapter. `"refused"`
   * fails the start — a session asked for context it could not be given
   * does not quietly start without it.
   */
  bindContext?: (sessionId: string) => Promise<SessionContextServerEntry | "refused" | undefined>;
  /**
   * Context to seed the session with, already resolved by the bridge.
   *
   * Optional, and absent is the default: a session starts knowing nothing
   * about TabDump unless a caller explicitly attached something. There is
   * deliberately no branch here that resolves context on the caller's
   * behalf — the service cannot reach the bridge, and a service that
   * resolved "the current workspace" by default would be the automatic
   * context injection this design exists to prevent.
   *
   * It is also, emphatically, not a permission. The grant is
   * `permissions`, and attaching a project's metadata here neither adds a
   * scope to that grant nor authorizes the project. `security.test.ts`
   * proves it by starting a session with project context and a grant of
   * nothing, then watching every local-effect operation still refuse.
   */
  context?: AgentAttachedContext;
};

export type ResumeInput = StartSessionInput & { providerSessionId: string };

export type AdoptSessionInput = {
  /** The existing session's id. Supplied, never minted — see `adoptSession`. */
  sessionId: string;
  provider: AgentProviderId;
  projectId?: string;
  workspaceId?: string;
  title?: string;
  /** The provider's own id, when durable state already recorded one. */
  providerSessionId?: string;
  /** The grant, re-read from the project by the caller rather than restored from a cache. */
  permissions?: AgentPermissionGrant;
  createdAt?: number;
};

export type ControlService = {
  /** Every session the service holds, newest first. */
  sessions(): AgentSession[];
  session(sessionId: string): AgentSession | undefined;
  approvals: ApprovalBroker;

  /** The current runtime decision, for a UI that needs to explain why nothing can run. */
  runtime(): RuntimeDecision;

  /** Whether this provider could be driven at all here — registration plus capability. */
  canDrive(provider: AgentProviderId, capability: AgentCapability): boolean;

  startSession(input: StartSessionInput): Promise<ControlResult<AgentSession>>;
  resumeSession(input: ResumeInput): Promise<ControlResult<AgentSession>>;

  /**
   * Rebuilds a session whose agent is already running.
   *
   * ## Why this is not `resumeSession`
   *
   * `resumeSession` starts something: it asks a provider to reattach to a
   * conversation by the provider's own id, and it mints a *new* TabDump
   * session to hold it. This does neither. The TabDump session already
   * exists, its id is already known, and the agent never stopped — what has
   * been lost is only this process's memory of it, which is the normal state
   * of affairs on a control plane where every request is a fresh process.
   *
   * So the id is supplied rather than minted, and the session comes back at
   * the status the adapter reports rather than starting from `created`. A
   * caller that used `resumeSession` for this would get a second session
   * record for one conversation, and the two would diverge.
   *
   * ## What it still does not skip
   *
   * The gate. An adopted session passes the same runtime, provider,
   * capability, project and permission checks a new one does, with the grant
   * re-read from the project rather than carried alongside the session. A
   * project whose authorization was revoked while the agent was running is
   * refused here, which is the point of re-reading.
   */
  adoptSession(input: AdoptSessionInput): Promise<ControlResult<AgentSession>>;
  sendMessage(message: AgentMessageInput): Promise<ControlResult<void>>;
  cancelRun(sessionId: string): Promise<ControlResult<void>>;
  respondToApproval(
    approvalId: string,
    decision: "granted" | "denied"
  ): Promise<ControlResult<void>>;

  /**
   * Puts a change to the session's own workspace to the user (Phase J.3).
   *
   * The same broker, the same approval card, the same Approve/Deny — the
   * request simply comes from TabDump's session MCP server rather than from
   * an adapter, so its answer goes back there. Resolves when the user
   * answers, the request expires, or the session ends.
   */
  requestWorkspaceApproval(
    sessionId: string,
    request: { targets: readonly string[]; reason: string }
  ): Promise<WorkspaceApprovalOutcome>;

  /** Withdraws a session's outstanding workspace approvals — it ended. */
  cancelWorkspaceApprovals(sessionId: string): void;

  /**
   * The context a session currently holds, or undefined for one holding none.
   *
   * The attachments, not the snapshot: the bridge owns that record, and this
   * is the control plane's view of it.
   */
  contextFor(sessionId: string): AgentAttachedContext | undefined;

  /**
   * Replaces a session's context with an already-resolved snapshot.
   *
   * The whole of `refreshContext` as far as the control plane is concerned.
   * Resolution — re-running scope, re-applying limits, minting a new
   * snapshot id — happens in the bridge before this is called, which is why
   * there is no `refresh` verb here: this layer cannot resolve anything, and
   * a method that implied it could would be the wrong seam.
   *
   * Replaces rather than merges. A session knows one thing at a time.
   */
  attachContext(sessionId: string, context: AgentAttachedContext): ControlResult<AgentSession>;

  /** Drops a session's context. The agent keeps whatever it was already told; nothing further is sent. */
  detachContext(sessionId: string): ControlResult<AgentSession>;

  /** Receives every well-formed event from every adapter. Returns the detach function. */
  subscribe(listener: (event: AgentControlEvent) => void): ControlUnsubscribe;

  /** Records that a session produced a domain run. Called by whatever correlates the two planes. */
  attachRun(sessionId: string, runId: string): void;

  /**
   * Records the provider's own identity for a session, once it is known.
   *
   * A provider that issues its id up front supplies it on the `SessionHandle`
   * and this is never needed. Claude Code does not: the id arrives on the
   * first frame of the stream, which is *after* `createSession` has resolved,
   * so without this a session that could be resumed would never say so.
   *
   * Write-once. A session whose provider identity changed under it would be a
   * different conversation wearing the same record, and the two could not be
   * told apart afterwards — so a second, different id is refused rather than
   * applied. Re-reporting the same one is a no-op, which is what a reconnect
   * does.
   */
  attachProviderSession(sessionId: string, providerSessionId: string): void;

  dispose(): void;
};

export function createControlService(options: ControlServiceOptions): ControlService {
  const now = options.now ?? (() => Date.now());
  const runtimeDecision = options.runtime ?? denyNonServerRuntime;
  const resolveProject = options.resolveProject ?? (() => undefined);
  const broker = options.broker ?? createApprovalBroker();
  let counter = 0;
  const createId = options.createId ?? (() => `cs-${++counter}-${now()}`);

  const sessions = new Map<string, AgentSession>();
  /** The grant each session was started under. Held here, never on the session record. */
  const grants = new Map<string, AgentPermissionGrant>();
  /**
   * The context each session holds.
   *
   * Beside the grants, and deliberately not merged with them: they are
   * indexed the same way and have the same lifetime, but one says what the
   * agent may do and the other says what it has been told. A single map
   * holding both would be one refactor away from a check that reads the
   * wrong half.
   */
  const contexts = new Map<string, AgentAttachedContext>();
  const listeners = new Set<(event: AgentControlEvent) => void>();
  const adapterSubscriptions = new Map<AgentProviderId, ControlUnsubscribe>();
  /** Workspace approvals (J.3) waiting on the user, and whom to tell. */
  const workspaceApprovals = new Map<string, (outcome: WorkspaceApprovalOutcome) => void>();

  function put(session: AgentSession): AgentSession {
    sessions.set(session.id, session);
    return session;
  }

  function move(session: AgentSession, to: AgentSessionStatus): AgentSession {
    const result = transitionSession(session, to, now());
    // A refused transition leaves the session exactly as it was. The caller
    // is already returning an error; corrupting the record on the way out
    // would turn a refusal into a second bug.
    if (!result.ok) return session;
    const moved = put(result.session);
    if (isTerminalSessionStatus(moved.status)) options.onSessionEnded?.(moved.id);
    return moved;
  }

  /** An event the service itself raises — for workspace approvals, which no adapter emits. */
  function emitOwn(session: AgentSession, kind: AgentControlEvent["kind"], summary: string, approvalId: string): void {
    const event: AgentControlEvent = {
      id: createId(),
      sessionId: session.id,
      provider: session.provider,
      kind,
      timestamp: now(),
      summary,
      approvalId,
    };
    if (!isWellFormedControlEvent(event)) return;
    applyEventToSession(session, event);
    for (const listener of [...listeners]) listener(event);
  }

  // A workspace approval is settled in the broker first — by the user, by
  // expiry, by cancellation — and only then is the context layer told.
  broker.watch((approval) => {
    const notify = workspaceApprovals.get(approval.id);
    if (!notify || approval.status === "requested") return;
    workspaceApprovals.delete(approval.id);
    const session = sessions.get(approval.sessionId);
    if (session && (approval.status === "granted" || approval.status === "denied")) {
      emitOwn(
        session,
        approval.status === "granted" ? "approval_granted" : "approval_denied",
        approval.status === "granted" ? "Workspace change approved" : "Workspace change declined",
        approval.id
      );
    }
    notify(approval.status as WorkspaceApprovalOutcome);
  });

  /**
   * The gate, for an operation that needs an adapter.
   *
   * Returns the adapter or the reason it may not be used. Every caller below
   * goes through it; there is deliberately no way to reach `resolveAdapter`
   * without passing here.
   */
  function gate(
    provider: AgentProviderId,
    capability: AgentCapability,
    projectId?: string,
    grant: AgentPermissionGrant = NO_PERMISSIONS
  ): ControlResult<AgentControlAdapter> {
    const decision = runtimeDecision();
    if (!decision.allowed) return controlFailure<AgentControlAdapter>("runtime-denied");

    const adapter = options.resolveAdapter(provider);
    if (!adapter) return controlFailure<AgentControlAdapter>("unsupported");

    if (!adapterSupports(adapter, capability)) {
      return controlFailure<AgentControlAdapter>("unsupported");
    }

    // A project-scoped operation needs a project that exists AND lists this
    // provider. Both, and in that order, so an unknown id can never fall
    // through to "authorized for everyone".
    if (projectId !== undefined) {
      const project = resolveProject(projectId);
      if (!project) return controlFailure<AgentControlAdapter>("project-denied");
      if (!isProviderAuthorized(project, provider)) {
        return controlFailure<AgentControlAdapter>("project-denied");
      }
    }

    if (!isCapabilityPermitted(capability, grant, projectId)) {
      return controlFailure<AgentControlAdapter>("permission-denied");
    }

    return { ok: true, value: adapter };
  }

  /**
   * Attaches to an adapter's event stream once, lazily.
   *
   * One subscription per provider however many sessions it has, so a
   * ten-session workspace does not attach ten listeners to one stream.
   */
  function ensureSubscribed(provider: AgentProviderId, adapter: AgentControlAdapter): void {
    if (adapterSubscriptions.has(provider)) return;

    const unsubscribe = adapter.subscribeToEvents((event) => {
      // Malformed events are dropped at the boundary rather than forwarded.
      // An adapter is not trusted to have normalized correctly, and a
      // `file_modified` with an absolute path must not reach a consumer.
      if (!isWellFormedControlEvent(event)) return;
      if (event.provider !== provider) return;

      const session = sessions.get(event.sessionId);
      if (!session) return;

      if (event.kind === "approval_requested" && event.approvalId) {
        recordApproval(adapter, session, event.approvalId);
      }

      applyEventToSession(session, event);
      for (const listener of [...listeners]) listener(event);
    });

    adapterSubscriptions.set(provider, unsubscribe);
  }

  /**
   * Mints the broker record behind an `approval_requested` event.
   *
   * ## Why this is here and not in the adapter
   *
   * An adapter that could reach the broker could mint an approval that was
   * already granted, so it has no route to one — it raises a request by
   * emitting an event, and this is where that event becomes a record the user
   * can answer. The adapter holds the detail (targets, reason, scope) because
   * an event deliberately has nowhere to carry it; the narrow accessor in
   * ./approval-details.ts is how it gets here, and it names no provider.
   *
   * ## The two refusals, and why they are opposite
   *
   * The broker can refuse to record a request, and *which* refusal it is
   * decides the answer:
   *
   *   - **`scope-needs-no-approval`** — the action falls under a scope the
   *     grant already settles (a read inside an authorized project). There is
   *     no question to put to anybody, so the adapter is told `granted`
   *     immediately. The alternative is a dialog that says "Claude would like
   *     to read a file you already let it read", which is how people learn to
   *     click yes without looking. The adapter has already checked the scope
   *     against the grant before emitting; this is not a second authorization,
   *     it is the absence of a question.
   *   - **anything else** — a malformed or unrecordable request. The agent is
   *     denied, because an approval nobody can answer must not become one
   *     nobody has to.
   *
   * Either way the adapter gets an answer. Leaving one unanswered would block
   * the provider on a decision that can never arrive.
   */
  function recordApproval(
    adapter: AgentControlAdapter,
    session: AgentSession,
    approvalId: string
  ): void {
    const details = readAdapterApprovalDetails(adapter, approvalId);

    function deny(): void {
      void adapter.respondToApproval(approvalId, "denied");
    }

    // An adapter that raised an approval it cannot describe. Nothing can be
    // put to the user, so nothing is granted.
    if (!details) return deny();

    // An action inside no project at all. The permission model refuses a
    // project-scoped grant that names no project, so this cannot be
    // authorized by anything, and there is nothing to ask.
    if (details.action && !details.projectId) return deny();

    if (details.action && details.projectId) {
      const requested = broker.request(
        {
          id: approvalId,
          sessionId: session.id,
          provider: session.provider,
          action: details.action,
          scope: details.scope,
          projectId: details.projectId,
          targets: details.targets,
          ...(details.runId ? { runId: details.runId } : {}),
          ...(details.reason ? { reason: details.reason } : {}),
        },
        now()
      );

      // Recorded. The user answers it, and `respondToApproval` carries their
      // decision back to the adapter.
      if (requested.ok) return;

      // Already recorded. An adapter reconnecting to a provider stream can
      // re-emit the request it raised a moment ago, and the first record is
      // still live and still waiting on the user — so there is nothing to do.
      // Answering here would resolve a decision they have not made, and
      // `denied` is no safer than `granted` when the effect is to cancel a
      // prompt that is on screen.
      if (requested.reason === "duplicate-id") return;

      // Malformed, or otherwise unrecordable.
      if (requested.reason !== "scope-needs-no-approval") return deny();
    }

    // Either the adapter named no action, or the broker refused to record one
    // because its scope needs no per-use approval. Both mean the same thing:
    // the grant already settles this, and there is no question to put to
    // anybody. See the note above on why that is a grant rather than a prompt.
    void adapter.respondToApproval(approvalId, "granted");
  }

  /**
   * Moves a session in response to what an adapter said.
   *
   * Only the statuses an event genuinely implies. An adapter cannot set a
   * session's status directly — it describes what happened, and the service
   * decides what that means for the lifecycle, refusing an impossible
   * transition rather than applying it.
   */
  function applyEventToSession(session: AgentSession, event: AgentControlEvent): void {
    switch (event.kind) {
      case "session_started":
      case "session_resumed":
        move(session, "ready");
        break;
      case "message_received":
      case "thinking":
      case "tool_started":
      case "command_started":
        if (session.status === "ready") move(session, "running");
        break;
      case "approval_requested":
        move(session, "waiting_for_approval");
        break;
      case "approval_granted":
      case "approval_denied":
        if (session.status === "waiting_for_approval") move(session, "running");
        break;
      case "waiting_for_input":
        move(session, "waiting_for_input");
        break;
      case "run_completed":
        move(session, "ready");
        break;
      case "run_cancelled":
        move(session, "cancelled");
        break;
      case "error":
        move(session, "failed");
        break;
      default:
        break;
    }
  }

  return {
    sessions: () => [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt),

    session: (sessionId) => sessions.get(sessionId),

    approvals: broker,

    runtime: runtimeDecision,

    canDrive(provider, capability) {
      if (!runtimeDecision().allowed) return false;
      const adapter = options.resolveAdapter(provider);
      return adapter ? adapterSupports(adapter, capability) : false;
    },

    async startSession(input) {
      const grant = input.permissions ?? NO_PERMISSIONS;
      const gated = gate(input.provider, "create_session", input.projectId, grant);
      if (!gated.ok) return { ok: false, error: gated.error };

      // Malformed context fails the whole start rather than being dropped.
      // Starting a session with silently less context than the caller
      // attached is the quiet failure the omission model exists to avoid,
      // and here there is no snapshot to record it on.
      if (input.context !== undefined && !isWellFormedAttachedContext(input.context)) {
        return controlFailure("invalid-request");
      }

      const project = input.projectId ? resolveProject(input.projectId) : undefined;
      const session = put(
        mintSession(
          {
            id: createId(),
            provider: input.provider,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            title: input.title,
            contextSnapshotId: input.context?.snapshotId,
          },
          now()
        )
      );
      grants.set(session.id, grant);
      if (input.context) contexts.set(session.id, input.context);

      // Workspace context (J.3): bound now that the session has an id, and
      // before the agent starts, so the agent's first request can use it.
      let contextServer: SessionContextServerEntry | undefined;
      if (input.bindContext) {
        const bound = await input.bindContext(session.id);
        if (bound === "refused") {
          move(session, "failed");
          return controlFailure("invalid-request");
        }
        contextServer = bound;
      }

      ensureSubscribed(input.provider, gated.value);
      const connecting = move(session, "connecting");

      const created = await gated.value.createSession({
        sessionId: session.id,
        project,
        permissions: grant,
        attachments: input.context?.attachments ?? [],
        title: input.title,
        ...(contextServer ? { contextServer } : {}),
      });

      if (!created.ok) {
        move(connecting, "failed");
        return { ok: false, error: created.error };
      }

      return { ok: true, value: adoptHandle(connecting, created.value) };
    },

    async resumeSession(input) {
      const grant = input.permissions ?? NO_PERMISSIONS;
      const gated = gate(input.provider, "resume_session", input.projectId, grant);
      if (!gated.ok) return { ok: false, error: gated.error };

      const project = input.projectId ? resolveProject(input.projectId) : undefined;
      const session = put(
        mintSession(
          {
            id: createId(),
            provider: input.provider,
            providerSessionId: input.providerSessionId,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            title: input.title,
          },
          now()
        )
      );
      grants.set(session.id, grant);

      ensureSubscribed(input.provider, gated.value);
      const connecting = move(session, "connecting");

      const resumed = await gated.value.resumeSession({
        sessionId: session.id,
        providerSessionId: input.providerSessionId,
        project,
        permissions: grant,
      });

      if (!resumed.ok) {
        move(connecting, "failed");
        return { ok: false, error: resumed.error };
      }

      return { ok: true, value: adoptHandle(connecting, resumed.value) };
    },

    async adoptSession(input) {
      // Already held by this process. Idempotent rather than an error: two
      // commands in one request can both ask, and the second finding the
      // session there is exactly the outcome it wanted.
      const held = sessions.get(input.sessionId);
      if (held) return { ok: true, value: held };

      const grant = input.permissions ?? NO_PERMISSIONS;
      // `create_session` rather than a capability of its own. Adopting is not
      // a new power — it reaches the same provider, in the same project, under
      // the same grant — so it is gated on being allowed to have started the
      // session in the first place.
      const gated = gate(input.provider, "create_session", input.projectId, grant);
      if (!gated.ok) return { ok: false, error: gated.error };

      const adapter = gated.value;
      if (!canReattachSession(adapter)) return controlFailure("unsupported");

      const project = input.projectId ? resolveProject(input.projectId) : undefined;
      const at = now();

      const session = put(
        mintSession(
          {
            id: input.sessionId,
            provider: input.provider,
            providerSessionId: input.providerSessionId,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            title: input.title,
          },
          // The session's real age, so a rebuilt record does not claim to have
          // been created by whichever request happened to pick it up.
          input.createdAt ?? at
        )
      );
      grants.set(session.id, grant);

      ensureSubscribed(input.provider, adapter);
      const connecting = move(session, "connecting");

      const reattached = await adapter.reattachSession({
        sessionId: input.sessionId,
        project,
        permissions: grant,
      });

      if (!reattached.ok) {
        // Left as `failed` rather than removed. A session the user can see in
        // their history, marked as unreachable, is more use than one that
        // silently vanished — and the durable record is the caller's to clean
        // up, not this layer's.
        move(connecting, "failed");
        return { ok: false, error: reattached.error };
      }

      return { ok: true, value: adoptHandle(connecting, reattached.value) };
    },

    async sendMessage(message) {
      if (!isWellFormedMessage(message)) return controlFailure("invalid-request");
      if (!isWellFormedContext(message.context)) return controlFailure("invalid-request");

      const session = sessions.get(message.sessionId);
      if (!session) return controlFailure("invalid-session");
      if (isTerminalSessionStatus(session.status)) return controlFailure("invalid-session");

      // A session stopped on an approval or a question must not be talked
      // over. The answer goes through the broker, not through a new message.
      if (session.status === "waiting_for_approval") return controlFailure("approval-required");

      const gated = gate(
        session.provider,
        "message",
        session.projectId,
        grants.get(session.id) ?? NO_PERMISSIONS
      );
      if (!gated.ok) return { ok: false, error: gated.error };

      const sent = await gated.value.sendMessage(message);
      if (!sent.ok) return sent;

      if (session.status === "ready") move(session, "running");
      return { ok: true, value: undefined };
    },

    async cancelRun(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return controlFailure("invalid-session");
      if (isTerminalSessionStatus(session.status)) return controlFailure("invalid-session");

      const gated = gate(
        session.provider,
        "cancel_run",
        session.projectId,
        grants.get(session.id) ?? NO_PERMISSIONS
      );
      if (!gated.ok) return { ok: false, error: gated.error };

      const cancelled = await gated.value.cancelRun(sessionId);
      if (!cancelled.ok) return cancelled;

      move(session, "cancelled");
      return { ok: true, value: undefined };
    },

    async respondToApproval(approvalId, decision) {
      const approval = broker.get(approvalId);
      if (!approval) return controlFailure("invalid-request");

      const session = sessions.get(approval.sessionId);
      if (!session) return controlFailure("invalid-session");

      // The broker is the source of truth and is settled FIRST. If the
      // adapter then fails, the user's decision still stands — in particular
      // a deny is never lost because a provider was unreachable.
      const settled = broker.resolve(approvalId, decision, now());
      if (!settled.ok) return controlFailure("invalid-request");

      // A workspace change was asked for by TabDump's session MCP server, not
      // by the adapter. The broker's watcher has already told it; there is no
      // adapter to answer.
      if (approval.workspaceId) return { ok: true, value: undefined };

      const gated = gate(
        session.provider,
        "approvals",
        session.projectId,
        grants.get(session.id) ?? NO_PERMISSIONS
      );
      if (!gated.ok) return { ok: false, error: gated.error };

      return gated.value.respondToApproval(approvalId, decision);
    },

    requestWorkspaceApproval(sessionId, request) {
      const session = sessions.get(sessionId);
      if (!session || !session.workspaceId || isTerminalSessionStatus(session.status)) {
        return Promise.resolve("cancelled");
      }
      const id = `wa-${createId()}`;
      const requested = broker.request(
        {
          id,
          sessionId,
          provider: session.provider,
          action: "change_workspace",
          scope: "write_workspace",
          workspaceId: session.workspaceId,
          targets: request.targets,
          reason: request.reason,
        },
        now()
      );
      // An approval nobody can answer must not become one nobody has to.
      if (!requested.ok) return Promise.resolve("denied");

      const outcome = new Promise<WorkspaceApprovalOutcome>((resolve) => {
        workspaceApprovals.set(id, resolve);
      });
      emitOwn(session, "approval_requested", "Wants to change your TabDump workspace", id);
      return outcome;
    },

    cancelWorkspaceApprovals(sessionId) {
      for (const approval of broker.forSession(sessionId)) {
        if (approval.workspaceId && approval.status === "requested") broker.cancel(approval.id, now());
      }
    },

    contextFor(sessionId) {
      return contexts.get(sessionId);
    },

    attachContext(sessionId, context) {
      if (!isWellFormedAttachedContext(context)) return controlFailure<AgentSession>("invalid-request");

      const session = sessions.get(sessionId);
      if (!session) return controlFailure<AgentSession>("invalid-session");
      // A finished session cannot be told anything new. Allowing it would
      // let a snapshot be attached to a transcript that is already closed,
      // making the record say the agent knew something it never saw.
      if (isTerminalSessionStatus(session.status)) return controlFailure<AgentSession>("invalid-session");

      contexts.set(sessionId, context);
      // Note the gate that is deliberately absent: there is none. Attaching
      // context is not an operation on the provider — nothing is dispatched,
      // no adapter is touched, no capability is consulted. It changes what
      // the *next* message will carry, and that message goes through the
      // full gate as it always did.
      return { ok: true, value: put(attachContextToSession(session, context.snapshotId, now())) };
    },

    detachContext(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return controlFailure<AgentSession>("invalid-session");

      contexts.delete(sessionId);
      if (session.contextSnapshotId === undefined) return { ok: true, value: session };

      const stripped: AgentSession = { ...session, updatedAt: now() };
      delete stripped.contextSnapshotId;
      return { ok: true, value: put(stripped) };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attachRun(sessionId, runId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      put(attachRunToSession(session, runId, now()));
    },

    attachProviderSession(sessionId, providerSessionId) {
      const session = sessions.get(sessionId);
      if (!session || !providerSessionId) return;
      if (session.providerSessionId !== undefined) return;
      put({ ...session, providerSessionId, updatedAt: now() });
    },

    dispose() {
      for (const unsubscribe of adapterSubscriptions.values()) unsubscribe();
      adapterSubscriptions.clear();
      listeners.clear();
      sessions.clear();
      grants.clear();
      contexts.clear();
    },
  };

  /** Folds an adapter's handle into the session record, without letting it set an impossible status. */
  function adoptHandle(session: AgentSession, handle: SessionHandle): AgentSession {
    const withId: AgentSession = handle.providerSessionId
      ? { ...session, providerSessionId: handle.providerSessionId, updatedAt: now() }
      : session;

    const stored = put(withId);
    return move(stored, handle.status);
  }
}
