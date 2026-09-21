import { createApprovalBroker } from "./approvals";
import { isWellFormedContext, isWellFormedMessage } from "./context";
import { isWellFormedControlEvent } from "./events";
import { isCapabilityPermitted, NO_PERMISSIONS } from "./permissions";
import { isProviderAuthorized } from "./projects";
import { denyNonServerRuntime } from "./runtime";
import {
  attachRunToSession,
  createSession as mintSession,
  isTerminalSessionStatus,
  transitionSession,
} from "./session";
import { adapterSupports, controlFailure } from "./types";
import type { ApprovalBroker } from "./approvals";
import type { AgentCapability } from "./capabilities";
import type { AgentMessageInput } from "./context";
import type { AgentControlEvent } from "./events";
import type { AgentPermissionGrant } from "./permissions";
import type { AgentProject } from "./projects";
import type { RuntimeDecision } from "./runtime";
import type { AgentSession, AgentSessionStatus } from "./session";
import type {
  AgentControlAdapter,
  ControlResult,
  ControlUnsubscribe,
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
};

export type StartSessionInput = {
  provider: AgentProviderId;
  projectId?: string;
  workspaceId?: string;
  title?: string;
  /** The grant for this session. Defaults to nothing granted. */
  permissions?: AgentPermissionGrant;
};

export type ResumeInput = StartSessionInput & { providerSessionId: string };

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
  sendMessage(message: AgentMessageInput): Promise<ControlResult<void>>;
  cancelRun(sessionId: string): Promise<ControlResult<void>>;
  respondToApproval(
    approvalId: string,
    decision: "granted" | "denied"
  ): Promise<ControlResult<void>>;

  /** Receives every well-formed event from every adapter. Returns the detach function. */
  subscribe(listener: (event: AgentControlEvent) => void): ControlUnsubscribe;

  /** Records that a session produced a domain run. Called by whatever correlates the two planes. */
  attachRun(sessionId: string, runId: string): void;

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
  const listeners = new Set<(event: AgentControlEvent) => void>();
  const adapterSubscriptions = new Map<AgentProviderId, ControlUnsubscribe>();

  function put(session: AgentSession): AgentSession {
    sessions.set(session.id, session);
    return session;
  }

  function move(session: AgentSession, to: AgentSessionStatus): AgentSession {
    const result = transitionSession(session, to, now());
    // A refused transition leaves the session exactly as it was. The caller
    // is already returning an error; corrupting the record on the way out
    // would turn a refusal into a second bug.
    return result.ok ? put(result.session) : session;
  }

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

      applyEventToSession(session, event);
      for (const listener of [...listeners]) listener(event);
    });

    adapterSubscriptions.set(provider, unsubscribe);
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

      const project = input.projectId ? resolveProject(input.projectId) : undefined;
      const session = put(
        mintSession(
          {
            id: createId(),
            provider: input.provider,
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

      const created = await gated.value.createSession({
        sessionId: session.id,
        project,
        permissions: grant,
        attachments: [],
        title: input.title,
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

      const gated = gate(
        session.provider,
        "approvals",
        session.projectId,
        grants.get(session.id) ?? NO_PERMISSIONS
      );
      if (!gated.ok) return { ok: false, error: gated.error };

      return gated.value.respondToApproval(approvalId, decision);
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

    dispose() {
      for (const unsubscribe of adapterSubscriptions.values()) unsubscribe();
      adapterSubscriptions.clear();
      listeners.clear();
      sessions.clear();
      grants.clear();
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
