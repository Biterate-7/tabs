import { hasAdapterAuthentication } from "@/lib/agents/control/authentication";
import { hasSessionRelease } from "@/lib/agents/control/session-release";
import { bindRunTo, drainAdapter, providerSessionIdOf } from "@/lib/agents/control/binding";
import { boundMessageText, normalizeControlSummary } from "@/lib/agents/control/events";
import { NO_PERMISSIONS } from "@/lib/agents/control/permissions";
import {
  isBlockedSessionStatus,
  isLiveSessionStatus,
  isTerminalSessionStatus,
} from "@/lib/agents/control/session";
import { createProject } from "@/lib/agents/control/projects";
import { adapterSupports } from "@/lib/agents/control/types";
import { createControlService } from "@/lib/agents/control/service";
import { createCorrelationRegistry, toCorrelationView } from "./correlation";
import { createEventJournal } from "./journal";
import { gateFailure } from "./gate";
import { runtimeFailure } from "./protocol";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentApproval } from "@/lib/agents/control/approvals";
import type { AgentControlEvent } from "@/lib/agents/control/events";
import type { AgentProject } from "@/lib/agents/control/projects";
import type { AgentSession } from "@/lib/agents/control/session";
import type { SessionContextAccess } from "@/lib/agents/session-context/capabilities";
import type { SessionContextRegistry } from "@/lib/agents/session-context/registry";
import type { AgentPermissionGrant } from "@/lib/agents/control/permissions";
import type {
  AgentControlAdapter,
  ControlError,
  ControlUnsubscribe,
  SessionContextServerEntry,
} from "@/lib/agents/control/types";
import type { CorrelationRegistry } from "./correlation";
import type { EventJournal } from "./journal";
import type { ExecutionGateResult } from "./gate";
import type {
  RuntimeApprovalView,
  RuntimeCommand,
  RuntimeCommandName,
  RuntimeCommandResult,
  RuntimeCommandResults,
  RuntimeCorrelationView,
  ProviderConnectionView,
  ProviderDetection,
  RuntimeErrorCode,
  RuntimeProviderStatus,
  RuntimeResult,
  RuntimeContextActionView,
  RuntimeSessionContextView,
  RuntimeSessionView,
  RuntimeStatus,
} from "./protocol";

/**
 * The trusted local runtime.
 *
 * ## What it is
 *
 * One process's worth of live agent control. It holds the `ControlService`,
 * the correlation registry and the event journal; it answers the fourteen
 * commands in ./protocol.ts and nothing else. Everything a provider can be
 * asked to do goes through it, and it is the only thing in TabDump that may
 * ask.
 *
 * ## Where the trust boundary is
 *
 *     browser  ──typed command──▶  transport  ──▶  HOST  ──▶  ControlService
 *                                                   │              │
 *                                            the boundary      provider adapter
 *
 * The boundary is *this object's construction*. A host cannot be built
 * without an `ExecutionGateResult`, and a refused gate produces a host that
 * answers `get_status` truthfully and refuses everything else — permanently,
 * with no path to re-deciding. That is why the gate is a constructor argument
 * rather than something consulted per command: a decision taken once, at the
 * point where a real server environment was available, cannot later be
 * influenced by a request.
 *
 * The browser is on the far side of a transport that carries data, not
 * closures. It cannot construct a host, cannot reach an adapter, cannot name
 * a path and cannot name a provider option. It can only send one of fourteen
 * verbs.
 *
 * ## What it deliberately does not do
 *
 * It does not persist. A host is the *live* layer: sessions it holds are
 * sessions a provider process is actually attached to, and when the process
 * dies they are gone, which is the honest state. The durable record lives in
 * the browser (see lib/agents/control/persistence.ts, which already restores
 * everything live as `disconnected` for exactly this reason), and a client
 * that remembers a session reattaches to it by asking for a resume rather
 * than by being told it is still running.
 *
 * It does not mint domain runs either. See ./correlation.ts: the agent domain
 * owns `AgentRun`, and what this mints is a *control run id* — TabDump's own
 * identifier for one stretch of driving — which the correlation registry then
 * joins to whatever observation independently discovers.
 */

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

/**
 * Who is asking.
 *
 * Resolved by the transport from the request itself — never read out of a
 * command body, which is why `RuntimeCommand` has no actor field for a caller
 * to set. On a deployment with accounts this is the signed-in account; on a
 * purely local TabDump, which has no accounts at all, it is the anonymous
 * local actor. Both are stable strings, and both are compared exactly.
 *
 * A session id alone is never sufficient to reach a session: every command
 * that names one re-derives the actor and compares it against the owner
 * recorded when the session was created.
 */
export type RuntimeActor = { id: string };

/** The actor a TabDump with no accounts configured runs as. */
export const LOCAL_ACTOR: RuntimeActor = { id: "local" };

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * One remote session as durable state remembers it.
 *
 * Deliberately not a `RuntimeSessionView`: this is what survives a process,
 * and the things a view carries — status, runs, approvals, sequence — are all
 * properties of a *live* session that this process has not picked up yet.
 * Conflating the two would mean inventing a status for a session nobody has
 * asked the provider about.
 */
export type RemoteSessionRef = {
  sessionId: string;
  provider: AgentProviderId;
  projectId: string;
  providerSessionId?: string;
  createdAt: number;
};

/**
 * How a remote host reaches the state that outlives it.
 *
 * ## Why the host takes this rather than a store
 *
 * Because the host must stay pure and drivable by tests with no database, no
 * cloud platform and no possibility of starting anything — exactly as it is
 * today. These three functions are the entire surface through which durable
 * state enters, they are all owner-scoped by signature, and a test supplies
 * them as plain async functions.
 *
 * Note what is absent: no sandbox, no path, no handle. The host learns that a
 * project exists and that a session exists; *reaching* either is the
 * adapter's business, through state the adapter resolves itself.
 */
export type RemoteHostBindings = {
  /**
   * Projects this actor owns, already resolved and owner-checked.
   *
   * Replaces whatever a client synced, rather than merging with it. On a
   * remote host the browser's local projects are directories on a machine
   * this process cannot see, and treating them as authorizations would be the
   * one genuinely dangerous confusion in this design.
   */
  projects(actorId: string): Promise<readonly AgentProject[]>;

  /** Sessions this actor owns, as durable state remembers them. */
  sessions(actorId: string): Promise<readonly RemoteSessionRef[]>;

  /** Drops a session's durable record. Called when the session is disposed. */
  forget(actorId: string, sessionId: string): Promise<void>;
};

export type RuntimeHostOptions = {
  /**
   * Whether this process may execute agents, decided once. See ./gate.ts.
   *
   * Required, and there is deliberately no default: a host built without an
   * answer would have to invent one, and the only safe invention is a refusal
   * that then looks like a bug.
   */
  gate: ExecutionGateResult;

  /**
   * Durable state, for a host whose execution plane is remote.
   *
   * Absent on every local host, and that absence is what makes a local host
   * incapable of rehydration — correctly, because a local agent is a child
   * process and a process that is gone has no session still running. See
   * `reattach` in the Claude runtime seam.
   */
  remote?: RemoteHostBindings;

  /** Resolves a provider's control adapter. Normally the connector registry's. */
  /**
   * Resolves a provider's control adapter, for one owner.
   *
   * The `ownerId` argument arrived with per-user provider credentials. A
   * Claude adapter is now built around *somebody's* credential source, so
   * "the adapter for claude-code" stopped being a well-formed question — two
   * signed-in accounts on one deployment must get two adapters, each able to
   * resolve only its own credential.
   *
   * A caller with nothing per-user to hold still writes `(provider) => ...`
   * and still means what it did, because a function of one parameter is
   * assignable to a type of two.
   */
  resolveAdapter: (provider: AgentProviderId, ownerId: string) => AgentControlAdapter | undefined;

  /**
   * A further source of authorized projects, consulted before the ones an
   * actor has synced.
   *
   * For a runtime that has a trusted source of its own - a desktop shell with
   * a native folder picker, a configured workspace - which this build does
   * not. Sessions normally resolve against what `authorize_projects` synced,
   * and that path is revalidated on arrival; see ./protocol.ts on exactly
   * what that does and does not prove.
   */
  resolveProject?: (projectId: string) => AgentProject | undefined;

  /** Providers this host reports on. Defaults to whatever resolves to an adapter. */
  providers?: readonly AgentProviderId[];

  now?: () => number;
  createId?: () => string;
  /** This process's identity. Injected so tests are deterministic. */
  runtimeId?: string;
  /**
   * What is installed on this machine (Phase J). Supplied only by a local
   * runtime's wiring; answered only when the gate is local. See
   * `lib/agents/launch/detect.ts` — it returns booleans, never paths.
   */
  detect?: () => readonly ProviderDetection[];
  /**
   * Workspace context for agent sessions (Phase J.3): the registry of
   * session bindings and the loopback MCP server agents reach them through.
   * Supplied only by a local runtime's wiring. Absent: sessions get no
   * workspace context, exactly as before.
   */
  sessionContext?: { registry: SessionContextRegistry; url(): Promise<string> };
};

/**
 * How much of its workspace a session may touch, from its grant — never from
 * the request (Phase J.3).
 *
 * Reading needs `read_workspace` in the project's grant; a session started
 * from a workspace with no project reads that one workspace and nothing else.
 * Writing needs `write_workspace`, which the user turns on for an agent, and
 * even then each change asks. `undefined`: no context at all.
 */
export function sessionContextAccessFor(
  grant: AgentPermissionGrant,
  projectId: string | undefined
): SessionContextAccess | undefined {
  if (projectId && !grant.scopes.includes("read_workspace")) return undefined;
  return projectId && grant.scopes.includes("write_workspace") ? "read_write" : "read";
}

export type RuntimeHost = {
  /** This process's identity, for the generation check. See `RuntimeStatus.runtimeId`. */
  readonly runtimeId: string;

  /** Runs one command on behalf of one actor. The entire public surface. */
  execute<N extends RuntimeCommandName>(
    actor: RuntimeActor,
    command: Extract<RuntimeCommand, { name: N }>
  ): Promise<RuntimeCommandResult<N>>;

  /** Live subscription, for a transport that can stream. Returns the detach function. */
  subscribe(listener: (event: AgentControlEvent & { sequence: number }) => void): ControlUnsubscribe;

  /** The correlation registry, for a caller joining observation to control. Read-mostly. */
  readonly correlations: CorrelationRegistry;

  readonly journal: EventJournal;

  /** Tears down every session and releases every provider process. */
  dispose(): Promise<void>;
};

/* ------------------------------------------------------------------ *
 * Error mapping
 * ------------------------------------------------------------------ */

/**
 * A control error, in the runtime's vocabulary.
 *
 * One mapping in one place. The two vocabularies overlap but do not coincide
 * — the control plane's `unsupported` covers both "no adapter" and "the
 * adapter does not do this", and a user needs those to read differently —
 * so the translation is explicit rather than a passthrough of codes.
 */
function runtimeCodeFor(error: ControlError): RuntimeErrorCode {
  switch (error.code) {
    case "runtime-denied":
      return "runtime_unavailable";
    case "unsupported":
      return "unsupported";
    case "permission-denied":
      return "permission_denied";
    case "approval-required":
      return "approval_required";
    case "project-denied":
      return "project_scope_violation";
    case "invalid-session":
      return "session_not_found";
    case "invalid-request":
      return "invalid_request";
    case "unreachable":
      return "provider_error";
    case "timeout":
      return "timeout";
    case "malformed-response":
      return "provider_error";
    case "configuration":
      return "authentication_required";
    case "approval-unenforceable":
      return "approval_unenforceable";
    case "unknown":
      return "provider_error";
  }
}

/** Restates a control-plane refusal as a runtime one. Takes the failure, so it cannot be handed a success. */
function fromControl<T>(result: { ok: false; error: ControlError }): RuntimeResult<T> {
  return runtimeFailure<T>(runtimeCodeFor(result.error));
}

/* ------------------------------------------------------------------ *
 * The host
 * ------------------------------------------------------------------ */

/** What the host tracks beside the control session. */
type HostSession = {
  /** The actor who created it. Compared on every subsequent command. */
  ownerId: string;
  provider: AgentProviderId;
  /** Control runs this session has produced, oldest first. */
  runIds: string[];
  /** The run in flight, if any. Cleared when the provider says the run ended. */
  activeRunId?: string;
  /** The correlation record joining this session to whatever observation finds. */
  correlationId: string;
  /**
   * A context snapshot that has been attached but not yet said to the agent.
   *
   * The control plane stores what a session holds and deliberately does not
   * deliver it — `attachContext` dispatches nothing, because changing what an
   * agent knows is not an operation on the provider. Something has to carry
   * it into the next message, and the host is the layer that knows both the
   * attachment and the message.
   *
   * Cleared once delivered, because a session's context is stated once rather
   * than restated every turn: repeating it would grow the conversation
   * without adding to it, and would make a later refresh ambiguous about
   * which version the model is working from.
   *
   * Not set by `create_session`. The adapter is handed that context at
   * creation and delivers it with the first message itself.
   */
  undeliveredContextSnapshotId?: string;
  /**
   * The session was started from a workspace, but its agent cannot prove
   * which of its calls are TabDump's (J.4), so it was not given the context
   * server. Said on the view rather than left to be guessed from an absence.
   */
  contextUnavailable?: true;
};

export function createRuntimeHost(options: RuntimeHostOptions): RuntimeHost {
  const now = options.now ?? (() => Date.now());
  /**
   * Random rather than sequential, and that is a security property rather
   * than a style preference.
   *
   * `ownership_denied` and `session_not_found` are deliberately different
   * answers, because a legitimate caller needs to tell "somebody else's" from
   * "gone". That distinction is only safe while a session id cannot be
   * guessed — with `session-1`, `session-2` it would be an existence oracle
   * for another account's sessions.
   */
  const createId = options.createId ?? (() => crypto.randomUUID());
  const runtimeId = options.runtimeId ?? createId();

  const correlations = createCorrelationRegistry({ createId: () => `corr-${createId()}` });
  const journal = createEventJournal();
  const listeners = new Set<(event: AgentControlEvent & { sequence: number }) => void>();
  const hosted = new Map<string, HostSession>();

  /**
   * Projects each actor has synced, by actor id then project id.
   *
   * Partitioned by actor rather than shared, so one account's authorized
   * directories are not another's - the same partition
   * `lib/storage/namespace.ts` already makes for everything else personal.
   * The nesting is what makes cross-account project access impossible rather
   * than merely checked.
   */
  const projectsByActor = new Map<string, Map<string, AgentProject>>();

  /**
   * The project this session may use.
   *
   * Consults the host's own trusted source first, then what this actor
   * synced. Never anything another actor synced, and never a path from a
   * request.
   */
  function projectFor(actorId: string, projectId: string): AgentProject | undefined {
    return options.resolveProject?.(projectId) ?? projectsByActor.get(actorId)?.get(projectId);
  }

  /**
   * Loads this actor's remote projects before anything can name one.
   *
   * Pre-resolved rather than looked up on demand, and that is a deliberate
   * shape rather than a convenience. `ControlService` resolves projects
   * *synchronously*, at the moment it authorizes a filesystem scope; making
   * that path async would mean an `await` inside the permission gate, which is
   * where a race becomes an authorization bug. Loading first and resolving
   * from memory keeps the security-critical path exactly as synchronous as it
   * has always been.
   *
   * Replaces rather than merges, for the reason on `RemoteHostBindings`.
   */
  async function hydrateProjects(actorId: string): Promise<void> {
    if (!options.remote) return;

    const projects = await options.remote.projects(actorId);
    const next = new Map<string, AgentProject>();
    for (const project of projects) next.set(project.id, project);
    projectsByActor.set(actorId, next);
  }

  /**
   * Picks a remote session back up, if this process does not already hold it.
   *
   * ## Why this exists and `own` could not do it
   *
   * `own` is synchronous and is called from the middle of command handling.
   * This has to talk to durable state and to a provider. So the rehydration
   * happens *before* the command runs, and `own` then finds the session in
   * memory exactly as it would on a long-lived local runtime — which is what
   * keeps every ownership check below unchanged.
   *
   * Ownership is still checked twice, and not redundantly: the bindings only
   * return sessions belonging to this actor, and `own` re-derives the same
   * answer from the host's own record. Two independent sources agreeing is
   * the property worth having.
   */
  async function ensureSession(actor: RuntimeActor, sessionId: string): Promise<void> {
    if (!options.remote || hosted.has(sessionId)) return;

    const refs = await options.remote.sessions(actor.id);
    const ref = refs.find((candidate) => candidate.sessionId === sessionId);
    if (!ref) return;

    const adopted = await serviceFor(actor.id).adoptSession({
      sessionId: ref.sessionId,
      provider: ref.provider,
      projectId: ref.projectId,
      ...(ref.providerSessionId ? { providerSessionId: ref.providerSessionId } : {}),
      // From the project, never from the durable session record. A grant
      // stored beside a session would be a grant that kept applying after the
      // user narrowed the project's permissions.
      permissions: grantFor(actor.id, ref.projectId),
      createdAt: ref.createdAt,
    });

    if (!adopted.ok) return;

    const correlation = correlations.register(
      {
        provider: ref.provider,
        origin: "control",
        controlSessionId: ref.sessionId,
        ...(ref.providerSessionId ? { providerSessionId: ref.providerSessionId } : {}),
      },
      now()
    );

    const host: HostSession = {
      ownerId: actor.id,
      provider: ref.provider,
      runIds: [],
      correlationId: correlation.id,
    };
    hosted.set(ref.sessionId, host);
    startRun(ref.sessionId, host);
  }

  /**
   * Collects whatever a non-pushing provider has said.
   *
   * Called before any command that reports on a session, so that what the
   * caller is told includes everything the agent has done — rather than
   * everything it had done as of whichever earlier request happened to be
   * listening. A local adapter has no `drainSession` and this is a no-op.
   */
  async function drainSession(actor: RuntimeActor, sessionId: string): Promise<void> {
    const host = hosted.get(sessionId);
    if (!host || host.ownerId !== actor.id) return;

    const adapter = options.resolveAdapter(host.provider, host.ownerId);
    if (adapter) await drainAdapter(adapter, sessionId);
  }

  /**
   * One control service per actor.
   *
   * ## Why not one service for the whole host
   *
   * A `ControlService` is constructed with one `resolveProject`, and a project
   * belongs to an actor. One shared service would have to be handed a resolver
   * that answered for whoever's command happened to be in flight - which means
   * a piece of mutable state that decides, at the moment of a filesystem
   * authorization, whose directories are in scope. That is a correctness
   * question turned into a timing question, and it is the kind that survives
   * review and fails under concurrency.
   *
   * A service per actor makes cross-actor project access structurally
   * impossible instead: account A's service was built with a resolver that
   * can only see account A's projects, and there is no argument any request
   * can carry that changes it.
   *
   * The cost is one adapter subscription per actor, which is what
   * `ensureSubscribed` already handles - an adapter's event stream takes many
   * listeners, and each service ignores events for sessions it does not hold.
   */
  const services = new Map<string, ReturnType<typeof createControlService>>();

  function serviceFor(actorId: string): ReturnType<typeof createControlService> {
    const existing = services.get(actorId);
    if (existing) return existing;

    const service = createControlService({
      // The gate's decision, frozen at construction. Not re-read, not
      // re-decided, and not reachable from a request.
      runtime: () => options.gate.decision,
      // Bound to this service's actor. The control service asks for "the
      // adapter for this provider"; which adapter that is depends on whose
      // service is asking, and this closure is where that is decided.
      resolveAdapter: (provider) => options.resolveAdapter(provider, actorId),
      resolveProject: (projectId) => projectFor(actorId, projectId),
      now,
      createId: () => `cs-${createId()}`,
      // A session that ends takes its workspace credential with it (J.3).
      onSessionEnded: (sessionId) => releaseContext(sessionId),
    });

    service.subscribe((event) => onEvent(event));
    services.set(actorId, service);
    return service;
  }

  /**
   * Every event any service forwards, journalled and fanned out.
   *
   * Three things happen here and the order matters:
   *
   *   1. **The journal decides.** A duplicate is dropped before anything else
   *      sees it, so a replayed `run_completed` cannot end a run twice and a
   *      replayed `approval_requested` cannot produce a second prompt.
   *   2. **Correlation is updated.** The provider's own session id arrives on
   *      its first frame, not when `createSession` resolves, so the earliest
   *      moment it can be recorded is here.
   *   3. **The run's life is tracked.** A terminal event clears
   *      `activeRunId`, which is what lets the next message start a new run
   *      rather than being refused as concurrent.
   */
  function onEvent(event: AgentControlEvent): void {
    const appended = journal.append(event);
    if (!appended.accepted) return;

    const session = hosted.get(event.sessionId);
    if (session) {
      captureProviderSession(event.sessionId, session);

      if (
        event.kind === "run_completed" ||
        event.kind === "run_cancelled" ||
        event.kind === "error"
      ) {
        delete session.activeRunId;
      }
    }

    for (const listener of [...listeners]) listener(appended.event);
  }

  /**
   * Records the provider's own session id the first time the adapter has one.
   *
   * Written to both places, because they answer different questions. The
   * correlation registry holds it as the *evidence* that joins control to
   * observation; the session record holds it as the handle a resume would
   * use. A session that had the first and not the second would be
   * correlatable and not resumable, which is a distinction with no meaning.
   */
  function captureProviderSession(sessionId: string, session: HostSession): void {
    const adapter = options.resolveAdapter(session.provider, session.ownerId);
    if (!adapter) return;

    const providerSessionId = providerSessionIdOf(adapter, sessionId);
    if (!providerSessionId) return;

    correlations.update(session.correlationId, { providerSessionId }, now());
    serviceFor(session.ownerId).attachProviderSession(sessionId, providerSessionId);
  }

  /**
   * Resolves a session the actor is allowed to touch.
   *
   * Ownership is checked before existence is revealed in any useful way:
   * both a missing session and somebody else's produce a refusal, and the two
   * codes differ only in what a *legitimate* caller learns. A caller probing
   * for another account's session ids gets `session_not_found` either way,
   * because `hosted` is keyed by an id they cannot guess and the ownership
   * check answers before the session record is returned.
   */
  function own(
    actor: RuntimeActor,
    sessionId: string
  ): RuntimeResult<{ session: AgentSession; host: HostSession }> {
    const host = hosted.get(sessionId);
    // Ownership before lookup. A session is only ever read out of the
    // service belonging to the actor who owns it, so there is no arrangement
    // of ids by which one actor's command reaches another's session record.
    if (!host) return runtimeFailure("session_not_found");
    if (host.ownerId !== actor.id) return runtimeFailure("ownership_denied");

    const session = serviceFor(actor.id).session(sessionId);
    if (!session) return runtimeFailure("session_not_found");
    return { ok: true, value: { session, host } };
  }

  /** Mints a control run, binds it to the adapter, and records it on the session. */
  function startRun(sessionId: string, host: HostSession): string {
    const runId = `cr-${createId()}`;

    const adapter = options.resolveAdapter(host.provider, host.ownerId);
    // An adapter that cannot be bound produces events with no run id. That is
    // recorded rather than pretended around: the run still exists as TabDump's
    // own unit of driving, and correlation simply has one less piece of
    // evidence for it.
    if (adapter) bindRunTo(adapter, sessionId, runId);

    host.runIds.push(runId);
    host.activeRunId = runId;
    serviceFor(host.ownerId).attachRun(sessionId, runId);
    correlations.update(host.correlationId, { controlRunId: runId }, now());

    return runId;
  }

  /* ---------------------------------------------------------------- *
   * Session workspace context (Phase J.3)
   * ---------------------------------------------------------------- */

  // A change an agent proposes goes to the service of the actor who owns the
  // session — the same broker, the same approval card as every other.
  options.sessionContext?.registry.setApprover(async (request) => {
    const ownerId = hosted.get(request.sessionId)?.ownerId;
    if (ownerId === undefined) return "cancelled";
    return serviceFor(ownerId).requestWorkspaceApproval(request.sessionId, {
      targets: request.targets,
      reason: request.reason,
      change: request.change,
    });
  });

  /** Revokes a session's credential and withdraws its pending workspace approvals. Idempotent. */
  function releaseContext(sessionId: string): void {
    options.sessionContext?.registry.release(sessionId);
    const ownerId = hosted.get(sessionId)?.ownerId;
    if (ownerId !== undefined) serviceFor(ownerId).cancelWorkspaceApprovals(sessionId);
  }

  function contextViewOf(sessionId: string): RuntimeSessionContextView | undefined {
    const registry = options.sessionContext?.registry;
    const binding = registry?.binding(sessionId);
    if (!registry || !binding) return undefined;
    return {
      workspaceId: binding.workspaceId,
      workspaceName: binding.snapshot.workspace.name,
      capabilities: [...binding.capabilities],
      version: binding.version,
      syncedAt: binding.syncedAt,
      fingerprint: binding.fingerprint,
      pendingActions: registry.pendingApplications(sessionId).map((action): RuntimeContextActionView => {
        const change = action.change;
        switch (change.kind) {
          case "create_collection":
            return { actionId: action.id, kind: change.kind, name: change.name, tabIds: [...change.tabIds] };
          case "rename_collection":
            return { actionId: action.id, kind: change.kind, collectionId: change.collectionId, name: change.name };
          case "add_tabs_to_collection":
            return { actionId: action.id, kind: change.kind, collectionId: change.collectionId, tabIds: [...change.tabIds] };
        }
      }),
    };
  }

  function approvalsFor(sessionId: string): RuntimeApprovalView[] {
    const ownerId = hosted.get(sessionId)?.ownerId;
    if (ownerId === undefined) return [];

    const at = now();
    return serviceFor(ownerId)
      .approvals.forSession(sessionId)
      .filter((approval) => approval.status === "requested" && approval.expiresAt > at)
      .map(toApprovalView);
  }

  function pendingApproval(sessionId: string): boolean {
    return approvalsFor(sessionId).length > 0;
  }

  /** The view a client gets. Assembled here so every command answers with the same shape. */
  function viewOf(session: AgentSession): RuntimeSessionView {
    const host = hosted.get(session.id);
    // A session with no host record is one this process did not create, so
    // there is no owner to resolve an adapter for. `undefined` reads through
    // the rest of this function as "not cancellable", which is true.
    const adapter = host ? options.resolveAdapter(session.provider, host.ownerId) : undefined;

    const view: RuntimeSessionView = {
      sessionId: session.id,
      provider: session.provider,
      status: session.status,
      runIds: host ? [...host.runIds] : [...session.runIds],
      awaitingApproval: pendingApproval(session.id),
      // Cancellable means the call would reach a provider, not merely that a
      // database row could be changed. A terminal session has no provider to
      // reach, and an adapter that never declared `cancel_run` would refuse.
      cancellable:
        !isTerminalSessionStatus(session.status) &&
        isLiveSessionStatus(session.status) &&
        Boolean(adapter && adapterSupports(adapter, "cancel_run")),
      // Resumable means a provider identity exists *and* the adapter can use
      // one. Neither half alone is enough, and claiming resumability without
      // both is how a UI ends up offering a button that cannot work.
      resumable:
        Boolean(session.providerSessionId) &&
        Boolean(adapter && adapterSupports(adapter, "resume_session")),
      latestSequence: journal.latestSequence(session.id),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };

    if (session.providerSessionId) view.providerSessionId = session.providerSessionId;
    if (session.projectId) view.projectId = session.projectId;
    if (session.workspaceId) view.workspaceId = session.workspaceId;
    if (session.title) view.title = session.title;
    if (session.contextSnapshotId) view.contextSnapshotId = session.contextSnapshotId;
    if (host?.activeRunId) view.activeRunId = host.activeRunId;
    const context = contextViewOf(session.id);
    if (context) view.context = context;
    else if (host?.contextUnavailable) view.contextUnavailable = "provider";

    return view;
  }

  /** The providers this host reports on, and what is true of each. */
  function providerStatuses(
    ownerId: string,
    only?: readonly AgentProviderId[]
  ): RuntimeProviderStatus[] {
    const ids =
      only ?? options.providers ?? [...hosted.values()].map((session) => session.provider);

    const unique = [...new Set(ids)];

    return unique.map((provider) => {
      const adapter = options.resolveAdapter(provider, ownerId);
      if (!adapter) {
        return {
          provider,
          connection: "unavailable" as const,
          available: false,
          authentication: "unknown" as const,
          capabilities: [],
        };
      }

      const status = adapter.getConnectionStatus();
      return {
        provider,
        connection: status.kind,
        // Available means an adapter exists and has not declared itself
        // unusable. It is emphatically not "authenticated" — see below.
        available: status.kind !== "unavailable",
        // Three separate facts, and this is the one TabDump usually cannot
        // know. Claude Code authenticates lazily: the first proof either way
        // arrives when a run starts, so anything before that is a guess.
        // `configuration_required` is the one state the provider has actually
        // told us about.
        //
        // An adapter with a native sign-in (Phase J) reports what the agent
        // itself last told it, which is the one better source there is.
        authentication: hasAdapterAuthentication(adapter)
          ? adapter.describeAuthentication().state
          : status.kind === "configuration_required"
            ? ("required" as const)
            : ("unknown" as const),
        capabilities: [...adapter.getCapabilities()],
        ...(hasAdapterAuthentication(adapter) ? { nativeSignIn: true } : {}),
      };
    });
  }

  function statusOf(actor: RuntimeActor): RuntimeStatus {
    const status: RuntimeStatus = {
      environment: options.gate.kind,
      executable: options.gate.allowed,
      runtimeId,
      providers: providerStatuses(actor.id),
    };

    if (!options.gate.allowed) status.detail = options.gate.detail;
    return status;
  }

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  async function run(
    actor: RuntimeActor,
    command: RuntimeCommand
  ): Promise<RuntimeResult<RuntimeCommandResults[RuntimeCommandName]>> {
    // `get_status` is the one command a refused runtime still answers. It has
    // to be: a UI that cannot ask "why not" can only show a blank screen.
    if (command.name === "get_status") return { ok: true, value: statusOf(actor) };

    if (!options.gate.allowed) return gateFailure();

    // Everything durable this command could need, loaded before it runs.
    //
    // Three steps, in this order, and the order is the design:
    //
    //   1. **Projects**, because a session cannot be rehydrated without the
    //      project that gives it its scope and its grant.
    //   2. **The session**, because every check below reads it from memory and
    //      must not have to await anything to do so.
    //   3. **The drain**, because what the caller is told should include
    //      everything the agent has done, not everything it had done as of
    //      whichever earlier request happened to be listening.
    //
    // All three are no-ops on a local host, which has no durable state and a
    // provider that pushes.
    await hydrateProjects(actor.id);

    const named = sessionIdOf(command);
    if (named) {
      await ensureSession(actor, named);
      await drainSession(actor, named);
    } else if (command.name === "respond_to_approval" && options.remote) {
      // The one command that names no session. An approval id alone does not
      // say which conversation it belongs to, and the broker that could answer
      // is empty until the session is picked up — so every one of this actor's
      // sessions is, bounded by the per-owner session limit.
      //
      // Draining is what actually makes the approval answerable: the pending
      // request is re-read from the provider's log and a resolver registered
      // for it, which is how a decision reaches an agent that has been blocked
      // since some earlier request on some other instance.
      for (const ref of await options.remote.sessions(actor.id)) {
        await ensureSession(actor, ref.sessionId);
        await drainSession(actor, ref.sessionId);
      }
    }

    // This actor's control service, and the only one this command can reach.
    const actorService = serviceFor(actor.id);

    switch (command.name) {
      case "authorize_projects": {
        // A remote host accepts none of them, and this is the single most
        // important refusal in the remote design.
        //
        // These records describe directories on the machine running the
        // browser. A hosted TabDump cannot see that machine, so a path from
        // one means nothing here — but it would still *validate*, because
        // `validateProjectPath` is checking the shape of a path and not the
        // existence of a filesystem. Accepting one would create an authorized
        // project whose path resolved, if it resolved at all, to a directory
        // on the server. That is the hosted-execution hole the whole Phase B
        // boundary exists to prevent, arriving through the one command that
        // carries a path.
        //
        // So they are refused by name rather than dropped silently: the client
        // syncs its local projects on every mount, and a silent no would leave
        // the user believing a project was authorized when it never could be.
        if (options.remote) {
          return {
            ok: true,
            value: {
              accepted: [],
              rejected: command.projects.map((candidate) => ({
                id: candidate.id,
                reason: "remote-runtime",
              })),
            },
          };
        }

        const accepted: string[] = [];
        const rejected: { id: string; reason: string }[] = [];
        const next = new Map<string, AgentProject>();

        for (const candidate of command.projects) {
          // Revalidated from scratch, not trusted. `createProject` re-runs
          // `validateProjectPath` on the root and on every additional
          // directory, and refuses a grant the permission model calls
          // incoherent - which is what stops a synced record from widening
          // itself between the browser and here.
          const made = createProject(
            {
              id: candidate.id,
              name: candidate.name,
              path: candidate.path,
              providers: candidate.providers,
              additionalDirectories: candidate.additionalDirectories ?? [],
              permissions: candidate.permissions as AgentProject["permissions"],
            },
            now()
          );

          if (!made.ok) {
            rejected.push({ id: candidate.id, reason: made.reason });
            continue;
          }

          next.set(made.project.id, made.project);
          accepted.push(made.project.id);
        }

        // Replaces rather than merges. A project the user revoked has to
        // disappear here on the next sync, and a merge would leave it
        // authorized until the process restarted.
        projectsByActor.set(actor.id, next);

        return { ok: true, value: { accepted, rejected } };
      }

      case "list_sessions": {
        const sessions = actorService
          .sessions()
          .filter((session) => hosted.get(session.id)?.ownerId === actor.id)
          .map(viewOf);

        // Sessions this process has not picked up are listed from durable
        // state as `disconnected`, which is exactly what they are *to this
        // process*: the agent may well be working, and nothing here has a
        // connection to it.
        //
        // Not adopted here on purpose. Adopting means a platform round trip
        // per session, and this is the command the UI polls — so the list
        // stays cheap and honest, and selecting a session is what reconnects
        // it. That is the same contract `control/persistence.ts` already
        // established for sessions restored after a reload, and the client
        // already knows how to reattach.
        if (options.remote) {
          for (const ref of await options.remote.sessions(actor.id)) {
            if (sessions.some((session) => session.sessionId === ref.sessionId)) continue;
            sessions.push(disconnectedView(ref));
          }
        }

        const owned = new Set(sessions.map((session) => session.sessionId));
        const views: RuntimeCorrelationView[] = correlations
          .list()
          // A correlation is visible when it belongs to one of this actor's
          // sessions, or when it is purely observational — an observed record
          // names nobody's control session and is not anybody's to hide.
          .filter(
            (record) =>
              record.controlSessionId === undefined || owned.has(record.controlSessionId)
          )
          .map(toCorrelationView);

        return { ok: true, value: { sessions, correlations: views } };
      }

      case "get_session": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;
        return {
          ok: true,
          value: {
            session: viewOf(owned.value.session),
            approvals: approvalsFor(command.sessionId),
          },
        };
      }

      case "get_events": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        const read = journal.read(command.sessionId, command.afterSequence);
        return { ok: true, value: { events: read.events, latestSequence: read.latestSequence } };
      }

      case "create_session": {
        const grant = grantFor(actor.id, command.projectId);
        const access = sessionContextAccessFor(grant, command.projectId);
        const sessionContext = options.sessionContext;
        const workspaceId = command.workspaceId;
        const wantsContext = Boolean(sessionContext && access && workspaceId && command.contextSnapshot);
        // Only an adapter that can prove which calls are the context server's
        // is handed one (J.4). Any other still starts — without context, and
        // the view says so.
        const providerAdapter = options.resolveAdapter(command.provider, actor.id);
        const carriesContext = Boolean(providerAdapter && adapterSupports(providerAdapter, "workspace_context"));
        const started = await actorService.startSession({
          ...(sessionContext && access && workspaceId && command.contextSnapshot && carriesContext
            ? {
                bindContext: async (sessionId: string) => {
                  const bound = await sessionContext.registry.bind({
                    sessionId,
                    ownerId: actor.id,
                    workspaceId,
                    access,
                    snapshot: command.contextSnapshot,
                  });
                  if (!bound) return "refused" as const;
                  // Handed to the service, which hands it to the one adapter starting
                  // the agent. It goes nowhere else. The capabilities are the
                  // runtime's, from the grant — never the request's.
                  const entry: SessionContextServerEntry = {
                    name: bound.serverName,
                    url: await sessionContext.url(),
                    token: bound.token,
                    workspaceId,
                    capabilities: [...(sessionContext.registry.binding(sessionId)?.capabilities ?? [])],
                  };
                  return entry;
                },
              }
            : {}),
          provider: command.provider,
          ...(command.projectId ? { projectId: command.projectId } : {}),
          ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
          ...(command.title ? { title: command.title } : {}),
          // The grant comes from the *project*, never from the request. A
          // client cannot ask for permissions; it can only name a project the
          // user already authorized, and the grant is whatever that project
          // carries. A session with no project gets nothing.
          permissions: grant,
          ...(command.context ? { context: command.context } : {}),
        });

        if (!started.ok) return fromControl(started);

        const correlation = correlations.register(
          {
            provider: command.provider,
            origin: "control",
            controlSessionId: started.value.id,
          },
          now()
        );

        const host: HostSession = {
          ownerId: actor.id,
          provider: command.provider,
          runIds: [],
          correlationId: correlation.id,
          ...(wantsContext && !carriesContext ? { contextUnavailable: true as const } : {}),
        };
        hosted.set(started.value.id, host);

        // The provider process is live the moment the session is, so the run
        // that drives it starts here rather than on the first message. A
        // session that never gets a message still had a run: the process
        // existed, and the events it emitted belong somewhere.
        startRun(started.value.id, host);
        captureProviderSession(started.value.id, host);

        const session = actorService.session(started.value.id);
        return session
          ? { ok: true, value: viewOf(session) }
          : runtimeFailure("session_not_found");
      }

      case "resume_session": {
        const resumed = await actorService.resumeSession({
          provider: command.provider,
          providerSessionId: command.providerSessionId,
          ...(command.projectId ? { projectId: command.projectId } : {}),
          ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
          ...(command.title ? { title: command.title } : {}),
          permissions: grantFor(actor.id, command.projectId),
        });

        if (!resumed.ok) return fromControl(resumed);

        const correlation = correlations.register(
          {
            provider: command.provider,
            origin: "control",
            controlSessionId: resumed.value.id,
            providerSessionId: command.providerSessionId,
          },
          now()
        );

        const host: HostSession = {
          ownerId: actor.id,
          provider: command.provider,
          runIds: [],
          correlationId: correlation.id,
        };
        hosted.set(resumed.value.id, host);
        startRun(resumed.value.id, host);

        const session = actorService.session(resumed.value.id);
        return session
          ? { ok: true, value: viewOf(session) }
          : runtimeFailure("session_not_found");
      }

      case "send_message": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        const { session, host } = owned.value;

        // Explicit serialization rather than unsafe concurrency. One provider
        // process holds one conversation; a second turn pushed into it while
        // the first is in flight would interleave two runs' events on one
        // stream, and nothing downstream could untangle them. Refusing is the
        // honest answer, and it is a *distinct* refusal so a UI can say "it is
        // still working" rather than "something went wrong".
        if (host.activeRunId && session.status === "running") {
          return runtimeFailure("invalid_session_state");
        }

        // Context owed to the agent rides along with this turn: whatever the
        // caller attached to the message, plus any snapshot attached to the
        // session since the last one was sent. The adapter deduplicates by
        // attachment identity, so a caller that supplies both does not state
        // anything twice.
        const owed = host.undeliveredContextSnapshotId
          ? (actorService.contextFor(command.sessionId)?.attachments ?? [])
          : [];

        const sent = await actorService.sendMessage({
          sessionId: command.sessionId,
          text: command.text,
          context: { attachments: [...owed, ...(command.context?.attachments ?? [])] },
        });

        if (!sent.ok) return fromControl(sent);

        // Cleared after the send rather than before, so a failed send leaves
        // the context still owed instead of silently dropping it.
        delete host.undeliveredContextSnapshotId;

        if (!host.activeRunId) startRun(command.sessionId, host);

        // What the user said, into the same journal as what the agent said,
        // so the conversation reads back whole after a reload. Journalled
        // here rather than by an adapter: the host is what received the text,
        // and an adapter re-emitting it from a provider's echo would double
        // it. Only the user's own words — the attached context is not
        // repeated into the stream.
        onEvent({
          id: `sent-${createId()}`,
          sessionId: command.sessionId,
          provider: host.provider,
          kind: "message_sent",
          timestamp: now(),
          summary: normalizeControlSummary(command.text),
          text: boundMessageText(command.text),
          ...(host.activeRunId ? { runId: host.activeRunId } : {}),
        });

        const after = actorService.session(command.sessionId);
        return after ? { ok: true, value: viewOf(after) } : runtimeFailure("session_not_found");
      }

      case "cancel_run": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        // Reaches the adapter, which reaches the provider's own interrupt.
        // There is deliberately no path here that marks the session cancelled
        // without the provider having been told: a status that said
        // "cancelled" over a process still editing files would be the worst
        // kind of lie this system could tell.
        const cancelled = await actorService.cancelRun(command.sessionId);
        if (!cancelled.ok) return fromControl(cancelled);

        delete owned.value.host.activeRunId;

        const after = actorService.session(command.sessionId);
        return after ? { ok: true, value: viewOf(after) } : runtimeFailure("session_not_found");
      }

      case "attach_context": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        // Note what is *not* consulted: the grant, the project, the
        // capabilities. Attaching context changes what the agent knows and
        // nothing about what it may do. Validated independently of the
        // project, exactly as the brief requires — and a malformed snapshot
        // fails the attach rather than being silently dropped.
        const attached = actorService.attachContext(command.sessionId, command.context);
        if (!attached.ok) {
          return attached.error.code === "invalid-request"
            ? runtimeFailure("context_invalid")
            : fromControl(attached);
        }

        owned.value.host.undeliveredContextSnapshotId = command.context.snapshotId;
        return { ok: true, value: viewOf(attached.value) };
      }

      case "detach_context": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        // Nothing further is sent; the agent keeps whatever it was already
        // told. A snapshot detached before it was ever delivered is simply
        // never said.
        delete owned.value.host.undeliveredContextSnapshotId;

        const detached = actorService.detachContext(command.sessionId);
        return detached.ok
          ? { ok: true, value: viewOf(detached.value) }
          : fromControl(detached);
      }

      case "respond_to_approval": {
        const approval = actorService.approvals.get(command.approvalId);
        if (!approval) return runtimeFailure("invalid_request");

        // The session's owner, not the approval's. An approval is answerable
        // only by whoever owns the session it belongs to — which is what stops
        // an approval id (a value that travels in an event) from being enough
        // on its own to authorize a tool.
        const owned = own(actor, approval.sessionId);
        if (!owned.ok) return owned;

        const answered = await actorService.respondToApproval(
          command.approvalId,
          command.decision
        );
        if (!answered.ok) return fromControl(answered);

        const after = actorService.session(approval.sessionId);
        return after ? { ok: true, value: viewOf(after) } : runtimeFailure("session_not_found");
      }

      case "dispose_session": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        // Cancel first, then forget. A session dropped from the host's map
        // while its provider process was still running would be a leaked
        // process nothing could reach — the exact failure the brief's cleanup
        // requirement names. `cancelRun` refuses on a terminal session, and
        // that refusal is not an error here.
        if (!isTerminalSessionStatus(owned.value.session.status)) {
          await actorService.cancelRun(command.sessionId);
        }
        releaseAdapterSession(actor.id, command.sessionId);
        releaseContext(command.sessionId);

        hosted.delete(command.sessionId);
        journal.forget(command.sessionId);
        correlations.removeControlSession(command.sessionId);

        // The durable record goes too, or the next request would rehydrate a
        // session the user just disposed of — and it would succeed, because
        // the agent is genuinely still there. The sandbox itself is left
        // alone: it belongs to the project, not to this session, and its own
        // deadline reclaims it.
        await options.remote?.forget(actor.id, command.sessionId);

        return { ok: true, value: { sessionId: command.sessionId } };
      }

      case "link_observation": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;

        // The observation half, supplied by the side that owns the domain.
        // Narrow on purpose: it associates three ids and can do nothing else.
        // A caller that names a run that does not exist has mislabelled its
        // own records and has not reached anything of anybody else's.
        const updated = correlations.update(
          owned.value.host.correlationId,
          {
            observationAgentId: command.observationAgentId,
            observationRunId: command.observationRunId,
          },
          now()
        );

        return updated
          ? { ok: true, value: toCorrelationView(updated) }
          : runtimeFailure("invalid_request");
      }

      /* ------------------------------------------------------------ *
       * Phase J — the connector lifecycle
       * ------------------------------------------------------------ */

      case "detect_providers": {
        // Only a runtime on the user's own machine may answer. A hosted or
        // remote deployment's binaries are not the user's, and listing them
        // would report the server's software to every visitor.
        const thisMachine = options.gate.kind === "local" && options.detect !== undefined;
        return {
          ok: true,
          value: { thisMachine, detections: thisMachine ? options.detect!() : [] },
        };
      }

      case "connect_provider": {
        const adapter = options.resolveAdapter(command.provider, actor.id);
        if (!adapter) return runtimeFailure("provider_unavailable");
        const connected = await adapter.connect();
        // A refusal is still an answer worth showing: the view carries the
        // status the adapter settled into, which says why.
        if (!connected.ok && connected.error.code === "unsupported") {
          return runtimeFailure("unsupported");
        }
        return { ok: true, value: connectionViewOf(command.provider, actor.id) };
      }

      case "authenticate_provider": {
        const adapter = options.resolveAdapter(command.provider, actor.id);
        if (!adapter) return runtimeFailure("provider_unavailable");
        if (!hasAdapterAuthentication(adapter)) return runtimeFailure("unsupported");
        const signedIn = await adapter.authenticate(command.methodId);
        if (!signedIn.ok) return fromControl(signedIn);
        return { ok: true, value: connectionViewOf(command.provider, actor.id) };
      }

      case "disconnect_provider": {
        const adapter = options.resolveAdapter(command.provider, actor.id);
        if (!adapter) return runtimeFailure("provider_unavailable");

        // This actor's sessions with this provider end first — cancelled,
        // forgotten, exactly as `dispose_session` does one — so disconnecting
        // cannot leave a process running that nothing can reach.
        for (const [sessionId, host] of [...hosted.entries()]) {
          if (host.ownerId !== actor.id || host.provider !== command.provider) continue;
          const session = actorService.session(sessionId);
          if (session && !isTerminalSessionStatus(session.status)) {
            await actorService.cancelRun(sessionId);
          }
          releaseAdapterSession(actor.id, sessionId);
          releaseContext(sessionId);
          hosted.delete(sessionId);
          journal.forget(sessionId);
          correlations.removeControlSession(sessionId);
        }

        await adapter.disconnect();
        return { ok: true, value: connectionViewOf(command.provider, actor.id) };
      }

      /* ------------------------------------------------------------ *
       * Phase J.3 — session workspace context
       * ------------------------------------------------------------ */

      case "sync_session_context": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;
        const registry = options.sessionContext?.registry;
        if (!registry?.binding(command.sessionId)) return runtimeFailure("invalid_session_state");
        // The binding's workspace is fixed; a snapshot of any other is refused here.
        const updated = registry.update(command.sessionId, command.snapshot);
        if (!updated) return runtimeFailure("context_invalid");
        return { ok: true, value: { sessionId: command.sessionId, version: updated.version } };
      }

      case "complete_context_action": {
        const owned = own(actor, command.sessionId);
        if (!owned.ok) return owned;
        const registry = options.sessionContext?.registry;
        if (!registry) return runtimeFailure("invalid_session_state");
        // Only an action the user approved, of this session, can be completed.
        if (!registry.complete(command.sessionId, command.actionId, command.outcome)) {
          return runtimeFailure("invalid_request");
        }
        return { ok: true, value: { sessionId: command.sessionId } };
      }
    }
  }

  /**
   * Lets the adapter end a session the host is about to forget (Phase J.2).
   * Cancelling a run does not end an ACP agent's process; without this, the
   * process outlived every reference to it until the runtime shut down.
   */
  function releaseAdapterSession(ownerId: string, sessionId: string): void {
    const provider = hosted.get(sessionId)?.provider;
    const adapter = provider ? options.resolveAdapter(provider, ownerId) : undefined;
    if (adapter && hasSessionRelease(adapter)) adapter.releaseSession(sessionId);
  }

  /** One provider's status plus the agent's own sign-in methods. */
  function connectionViewOf(provider: AgentProviderId, ownerId: string): ProviderConnectionView {
    const status =
      providerStatuses(ownerId, [provider])[0] ?? {
        provider,
        connection: "unavailable" as const,
        available: false,
        authentication: "unknown" as const,
        capabilities: [],
      };
    const adapter = options.resolveAdapter(provider, ownerId);
    const methods =
      adapter && hasAdapterAuthentication(adapter) ? adapter.describeAuthentication().methods : [];
    return { ...status, authMethods: methods.map((method) => ({ ...method })) };
  }

  /**
   * The grant a project carries, or nothing.
   *
   * Never anything a client supplied on the command. A caller can name a
   * project; it cannot ask for permissions, and a project it has not
   * authorized resolves to nothing rather than to a default.
   */
  function grantFor(actorId: string, projectId?: string) {
    if (!projectId) return NO_PERMISSIONS;
    const project = projectFor(actorId, projectId);
    return project ? project.permissions : NO_PERMISSIONS;
  }

  return {
    runtimeId,

    execute: run as RuntimeHost["execute"],

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    correlations,
    journal,

    async dispose() {
      // Every live session is cancelled before its service is torn down, so
      // no provider process outlives the host that started it. Failures are
      // ignored deliberately: a session whose provider is already gone is
      // exactly the case where cancelling refuses, and it is not a reason to
      // abandon the rest of the teardown.
      for (const [sessionId, host] of hosted) {
        const actorService = serviceFor(host.ownerId);
        const session = actorService.session(sessionId);
        if (session && !isTerminalSessionStatus(session.status)) {
          await actorService.cancelRun(sessionId).catch(() => undefined);
        }
        correlations.removeControlSession(sessionId);
      }

      // Every workspace credential stops working with the runtime (J.3).
      options.sessionContext?.registry.releaseAll();

      hosted.clear();
      journal.clear();
      listeners.clear();
      projectsByActor.clear();

      // Each service's own dispose releases its adapter subscriptions. An
      // adapter is shared across actors, so it is *not* disposed here: the
      // host does not own it, and disposing one would tear down another
      // host's sessions in the same process.
      for (const service of services.values()) service.dispose();
      services.clear();
    },
  };
}

/**
 * A durable session this process has not picked up, as a view.
 *
 * Every live-only field is reported at its empty value rather than guessed:
 * no runs, no active run, no approvals, sequence zero. The one field that is
 * an assertion is `resumable`, and it is true — a remote session's whole
 * point is that the agent is still there — which is what tells the client
 * this row is worth selecting.
 */
function disconnectedView(ref: RemoteSessionRef): RuntimeSessionView {
  const view: RuntimeSessionView = {
    sessionId: ref.sessionId,
    provider: ref.provider,
    // Honest, and specifically about *this process*: there is no connection
    // to the agent from here. Selecting the session is what makes one.
    status: "disconnected",
    projectId: ref.projectId,
    runIds: [],
    awaitingApproval: false,
    cancellable: false,
    resumable: true,
    latestSequence: 0,
    createdAt: ref.createdAt,
    updatedAt: ref.createdAt,
  };
  if (ref.providerSessionId) view.providerSessionId = ref.providerSessionId;
  return view;
}

/**
 * The session a command names, if it names one.
 *
 * A switch over the closed union rather than `"sessionId" in command`, so
 * that a fifteenth command is a type error here rather than a command that
 * silently skips rehydration and reports an empty session on a remote host.
 *
 * `respond_to_approval` is absent on purpose: it names an approval, and which
 * session that belongs to cannot be known until the sessions are loaded. Its
 * caller handles that case explicitly.
 */
function sessionIdOf(command: RuntimeCommand): string | undefined {
  switch (command.name) {
    case "get_session":
    case "get_events":
    case "send_message":
    case "cancel_run":
    case "attach_context":
    case "detach_context":
    case "dispose_session":
    case "link_observation":
    case "sync_session_context":
    case "complete_context_action":
      return command.sessionId;
    case "get_status":
    case "list_sessions":
    case "authorize_projects":
    case "create_session":
    case "resume_session":
    case "respond_to_approval":
    case "detect_providers":
    case "connect_provider":
    case "authenticate_provider":
    case "disconnect_provider":
      return undefined;
  }
}

/** Strips an approval to what a client may see. Targets are already project-relative. */
function toApprovalView(approval: AgentApproval): RuntimeApprovalView {
  const view: RuntimeApprovalView = {
    approvalId: approval.id,
    sessionId: approval.sessionId,
    provider: approval.provider,
    action: approval.action,
    scope: approval.scope,
    ...(approval.projectId ? { projectId: approval.projectId } : {}),
    ...(approval.workspaceId ? { workspaceId: approval.workspaceId } : {}),
    targets: [...approval.targets],
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
  };

  if (approval.runId) view.runId = approval.runId;
  if (approval.reason) view.reason = approval.reason;
  if (approval.change) view.change = { ...approval.change, details: [...approval.change.details] };
  return view;
}

/**
 * Whether a session is stopped on something only the user can supply.
 *
 * Re-exported through the host's own vocabulary so a consumer does not have to
 * import the control plane's session module to ask a question the runtime
 * already answers.
 */
export function isWaitingOnUser(view: RuntimeSessionView): boolean {
  return isBlockedSessionStatus(view.status);
}

/** What a client should carry as context when reattaching. */
export type ReconnectCursor = { sessionId: string; afterSequence: number };

/**
 * The cursor a client should come back with.
 *
 * Trivial, and it exists so the reconnect contract is written down in one
 * place rather than assembled by each caller: a client that reattaches sends
 * the last sequence it saw, and gets everything after it. See ./journal.ts on
 * what happens when that cursor has fallen off the back of the ring.
 */
export function cursorFor(view: RuntimeSessionView): ReconnectCursor {
  return { sessionId: view.sessionId, afterSequence: view.latestSequence };
}

