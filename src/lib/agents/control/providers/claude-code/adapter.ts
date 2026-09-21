import { capabilitySet } from "../../capabilities";
import { controlError, controlFailure } from "../../types";
import { containsPath } from "../../projects";
import { normalizeClaudeMessage, providerSessionIdOf } from "./normalize";
import { isToolPermitted, planForGrant, scopeForTool } from "./permissions";
import type { AgentCapabilitySet } from "../../capabilities";
import type { AgentMessageInput } from "../../context";
import type { AgentControlEvent } from "../../events";
import type { AgentPermissionGrant, AgentPermissionScope } from "../../permissions";
import type { AgentProject } from "../../projects";
import type {
  AgentControlAdapter,
  ControlEventListener,
  ControlResult,
  ControlStatus,
  ControlStatusListener,
  ControlUnsubscribe,
  CreateSessionRequest,
  ResumeSessionRequest,
  SessionHandle,
} from "../../types";
import type {
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudeRuntime,
  ClaudeRuntimeError,
  ClaudeRuntimeHandle,
  ClaudeRuntimeMessage,
} from "./runtime";

/**
 * The Claude Code control adapter.
 *
 * ## What is real here
 *
 * Everything below drives an actual Claude Code process through
 * `@anthropic-ai/claude-agent-sdk` (see ./sdk-runtime.ts). Sessions are real,
 * messages reach the model, output streams back as it arrives, cancellation
 * interrupts the running turn, resume reattaches to the provider's own
 * session, and approvals originate from the provider's `canUseTool` callback
 * and genuinely block until answered.
 *
 * ## Why the SDK rather than the CLI
 *
 * The deciding factor is approvals. Claude Code 2.1.229's CLI has **no
 * `--permission-prompt-tool` flag** — verified against `claude --help` on the
 * installed binary, not assumed from documentation. `--permission-mode`
 * chooses a policy up front and cannot hand an individual tool call back for
 * a decision, so the CLI alone can express "allow all edits" or "allow
 * nothing" and cannot express *"Claude wants to modify these 4 files —
 * approve?"*.
 *
 * The SDK's `canUseTool` is invoked per tool call and awaits a verdict, which
 * is exactly the shape the approval broker needs. Everything else the CLI
 * offers, the SDK offers too: `cwd`, `additionalDirectories`, `resume`,
 * `allowedTools`, streaming input for multi-turn, and `interrupt()`.
 *
 * ## The boundaries this adapter sits inside
 *
 * It is handed an **already-validated, already-authorized** request. It does
 * not resolve projects, does not consult the runtime boundary, does not
 * decide permissions and cannot mint an approval. The control service does
 * all four before dispatch. What this adapter adds is a *second* check on the
 * provider's side — `isToolPermitted` on every live permission request — so
 * that a bug in the service's gate is still caught here.
 */

/**
 * What this adapter genuinely implements.
 *
 * Each one is exercised by a test against the deterministic runtime, and the
 * whole set again by the opt-in integration test against real Claude Code.
 *
 * `mcp` is **absent and stays absent**: TabDump configures no MCP servers, so
 * there is nothing to declare. See the MCP note in
 * docs/claude-code-control.md — advertising it because the provider has a
 * flag is exactly the thing the capability model forbids.
 */
export const CLAUDE_CODE_CONTROL_CAPABILITIES: AgentCapabilitySet = capabilitySet(
  "message",
  "create_session",
  "resume_session",
  "cancel_run",
  "stream_events",
  "read_files",
  "write_files",
  "run_commands",
  "approvals",
  "working_directory",
  "additional_directories"
);

/** Maps a runtime failure onto the control plane's fixed error table. */
function controlCodeFor(error: ClaudeRuntimeError) {
  switch (error.code) {
    case "not-installed":
    case "unavailable":
      return "unsupported" as const;
    case "authentication":
      return "configuration" as const;
    case "timeout":
      return "timeout" as const;
    case "malformed":
      return "malformed-response" as const;
    case "process-failed":
    case "unknown":
      return "unknown" as const;
  }
}

/** One live session this adapter is driving. */
type LiveSession = {
  sessionId: string;
  handle: ClaudeRuntimeHandle;
  project?: AgentProject;
  grant: AgentPermissionGrant;
  providerSessionId?: string;
  runId?: string;
  /** Approvals awaiting an answer, by the id the adapter minted for them. */
  pending: Map<string, (decision: ClaudePermissionDecision) => void>;
};

export type ClaudeCodeControlAdapterOptions = {
  runtime: ClaudeRuntime;
  now?: () => number;
  /** Mints event and approval ids. Injected so tests are deterministic. */
  createId?: () => string;
};

/**
 * The Claude adapter, plus the one accessor the generic contract must not
 * grow.
 *
 * `AgentControlAdapter` stays provider-neutral — the guard test asserts it
 * declares no provider-shaped member. The approval *detail* (targets, reason,
 * scope) has nowhere to live on a control event, which deliberately carries
 * no payload, so the service collects it through this narrow, typed accessor
 * after checking the adapter offers one.
 */
export type ClaudeCodeControlAdapter = AgentControlAdapter & {
  takeApprovalDetails(approvalId: string): ClaudeApprovalDetails | undefined;
  /**
   * The provider's own session id, once the stream has revealed one.
   *
   * Not available when `createSession` resolves: the id arrives on the
   * provider's first frame, which is after the run is live. A caller that
   * wants to persist a resumable handle reads it here once
   * `session_started` has been seen.
   *
   * Outside `AgentControlAdapter` for the same reason
   * `takeApprovalDetails` is — the generic contract stays provider-neutral,
   * and `SessionHandle.providerSessionId` already covers the resume case
   * where the id is known up front.
   */
  providerSessionIdFor(sessionId: string): string | undefined;
  /**
   * Binds this session's events to a domain run.
   *
   * The control plane does not mint domain runs — the observation plane and
   * the agent domain own those, and a second minter would be a second
   * representation of the same work. Whoever correlates the two planes calls
   * this, and every event emitted afterwards carries the run id, which is
   * what lets `toDomainEventInput` reduce one into the durable activity log.
   *
   * Until it is called, events carry no run and reduce to nothing. That is
   * the honest state for Phase C, where nothing correlates the planes yet.
   */
  bindRun(sessionId: string, runId: string): void;
};

export function createClaudeCodeControlAdapter(
  options: ClaudeCodeControlAdapterOptions
): ClaudeCodeControlAdapter {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const createId = options.createId ?? (() => `cc-${++counter}-${now()}`);

  const sessions = new Map<string, LiveSession>();
  const eventListeners = new Set<ControlEventListener>();
  const statusListeners = new Set<ControlStatusListener>();

  let status: ControlStatus = { kind: "disconnected", since: now() };

  function setStatus(next: ControlStatus): void {
    status = next;
    for (const listener of [...statusListeners]) listener(status);
  }

  function emit(event: AgentControlEvent): void {
    for (const listener of [...eventListeners]) listener(event);
  }

  function emitAll(events: AgentControlEvent[]): void {
    for (const event of events) emit(event);
  }

  /**
   * Turns a provider message into events, and keeps the session's correlation
   * up to date.
   *
   * The provider session id is captured from the first frame that carries
   * one. That is what makes a resume possible even if the run then fails:
   * the id is known before any work happens.
   */
  function handleMessage(session: LiveSession, message: ClaudeRuntimeMessage): void {
    const providerSessionId = providerSessionIdOf(message);
    if (providerSessionId && !session.providerSessionId) {
      session.providerSessionId = providerSessionId;
    }

    emitAll(
      normalizeClaudeMessage(message, {
        sessionId: session.sessionId,
        projectId: session.project?.id,
        projectPath: session.project?.path,
        runId: session.runId,
        now: now(),
        createId,
      })
    );
  }

  /**
   * The targets an approval names.
   *
   * Project-relative, or the tool name when no path reduces. Never an
   * absolute path: the approval is the sentence a user reads before saying
   * yes, and it must describe something inside the project they think they
   * are authorizing.
   */
  function targetsFor(request: ClaudePermissionRequest, session: LiveSession): string[] {
    const targets: string[] = [];

    if (session.project) {
      for (const key of ["file_path", "notebook_path", "path"]) {
        const value = request.input[key];
        if (typeof value !== "string" || !value) continue;

        const contained = containsPath(session.project, value);
        if (contained.ok) targets.push(contained.relativePath);
      }

      if (request.blockedPath) {
        const contained = containsPath(session.project, request.blockedPath);
        if (contained.ok && !targets.includes(contained.relativePath)) {
          targets.push(contained.relativePath);
        }
      }
    }

    // A tool with no reducible path — Bash, WebFetch — is named by the tool
    // itself rather than by an invented target.
    return targets.length > 0 ? targets : [request.toolName];
  }

  /**
   * The provider is asking permission.
   *
   * Three things happen, in order, and the order is the design:
   *
   *   1. **TabDump's own check first.** A tool whose scope was never granted
   *      is denied here without ever reaching the user. Asking about
   *      something that is not permitted anyway would train someone to click
   *      through prompts.
   *   2. **An `approval_requested` event is emitted.** That is how the
   *      request reaches the broker — the adapter has no route to it, by
   *      design, so it cannot mint one already granted.
   *   3. **The promise is held open.** It resolves only when
   *      `respondToApproval` is called, or when the run is interrupted. There
   *      is no timeout here and no default: a decision that never arrives
   *      leaves the agent blocked, which is the safe direction.
   */
  async function handlePermission(
    session: LiveSession,
    request: ClaudePermissionRequest
  ): Promise<ClaudePermissionDecision> {
    if (!isToolPermitted(request.toolName, session.grant, session.project?.id)) {
      return {
        behavior: "deny",
        message: "TabDump has not been given permission for that in this project.",
      };
    }

    const approvalId = createId();
    const scope: AgentPermissionScope = scopeForTool(request.toolName) ?? "run_commands";

    emit({
      id: createId(),
      sessionId: session.sessionId,
      provider: "claude-code",
      kind: "approval_requested",
      timestamp: now(),
      // The provider's own sentence when it supplied one. Nothing is
      // invented: a provider that says nothing yields the tool name.
      summary: request.title ?? request.displayName ?? request.toolName,
      approvalId,
      ...(session.runId ? { runId: session.runId } : {}),
      tool: { name: request.toolName, callId: request.toolUseId },
    });

    // Surfaced separately so the service can mint the broker record with
    // everything the future dialog needs.
    pendingDetails.set(approvalId, {
      sessionId: session.sessionId,
      runId: session.runId,
      toolName: request.toolName,
      scope,
      projectId: session.project?.id,
      targets: targetsFor(request, session),
      reason: request.description ?? request.decisionReason,
    });

    return new Promise<ClaudePermissionDecision>((resolve) => {
      session.pending.set(approvalId, resolve);

      // An interrupted run must not leave the provider waiting on a decision
      // nobody will give. Denying on abort is the fail-closed direction.
      request.signal.addEventListener(
        "abort",
        () => {
          if (!session.pending.has(approvalId)) return;
          session.pending.delete(approvalId);
          pendingDetails.delete(approvalId);
          resolve({ behavior: "deny", message: "The run was cancelled." });
        },
        { once: true }
      );
    });
  }

  /**
   * What each pending approval was about.
   *
   * Held beside the resolver rather than inside the event, because the event
   * model deliberately has nowhere to put a target list or a reason — those
   * belong to the broker's record, and `takeApprovalDetails` is how the
   * service collects them.
   */
  const pendingDetails = new Map<string, ClaudeApprovalDetails>();

  function finishSession(session: LiveSession, error?: ClaudeRuntimeError): void {
    // Any approval still outstanding when the run ends is resolved as denied,
    // so no promise is left dangling and no provider is left blocked.
    for (const [approvalId, resolve] of session.pending) {
      pendingDetails.delete(approvalId);
      resolve({ behavior: "deny", message: "The session ended." });
    }
    session.pending.clear();

    if (error) {
      emit({
        id: createId(),
        sessionId: session.sessionId,
        provider: "claude-code",
        kind: "error",
        timestamp: now(),
        summary: controlError(controlCodeFor(error)).message,
        ...(session.runId ? { runId: session.runId } : {}),
      });
    }

    sessions.delete(session.sessionId);
  }

  async function startRun(
    sessionId: string,
    project: AgentProject | undefined,
    grant: AgentPermissionGrant,
    resume?: string
  ): Promise<ControlResult<SessionHandle>> {
    const plan = planForGrant(grant, project?.id);

    const session: LiveSession = {
      sessionId,
      handle: null as unknown as ClaudeRuntimeHandle,
      project,
      grant,
      pending: new Map(),
      ...(resume ? { providerSessionId: resume } : {}),
    };

    const started = await options.runtime.start({
      sessionId,
      ...(project ? { cwd: project.path } : {}),
      // Exactly what the project authorized, and nothing derived. Each entry
      // was validated as strictly as the root when the project was created,
      // and revalidated on load — see ../../projects.ts.
      additionalDirectories: project ? project.additionalDirectories : [],
      permissionMode: plan.mode,
      allowedTools: plan.allowedTools,
      disallowedTools: plan.disallowedTools,
      ...(resume ? { resume } : {}),
      onMessage: (message) => handleMessage(session, message),
      onPermissionRequest: (request) => handlePermission(session, request),
      onExit: (error) => finishSession(session, error),
    });

    if (!started.ok) {
      return controlFailure<SessionHandle>(controlCodeFor(started.error));
    }

    session.handle = started.handle;
    sessions.set(sessionId, session);

    const handle: SessionHandle = { sessionId, status: "ready" };
    if (session.providerSessionId) handle.providerSessionId = session.providerSessionId;
    return { ok: true, value: handle };
  }

  return {
    provider: "claude-code",

    getCapabilities: () => CLAUDE_CODE_CONTROL_CAPABILITIES,

    getConnectionStatus: () => status,

    async connect() {
      setStatus({ kind: "connecting", since: now() });

      const available = await options.runtime.isAvailable();
      if (!available) {
        const next: ControlStatus = {
          kind: "unavailable",
          since: now(),
          lastError: controlError("unsupported"),
          detail: "Claude Code is not available on this machine.",
        };
        setStatus(next);
        return controlFailure<ControlStatus>("unsupported");
      }

      const next: ControlStatus = { kind: "connected", since: now() };
      setStatus(next);
      return { ok: true, value: next };
    },

    async disconnect() {
      for (const session of [...sessions.values()]) {
        await session.handle?.dispose();
        finishSession(session);
      }
      setStatus({ kind: "disconnected", since: now() });
    },

    createSession(request: CreateSessionRequest) {
      return startRun(request.sessionId, request.project, request.permissions);
    },

    resumeSession(request: ResumeSessionRequest) {
      return startRun(
        request.sessionId,
        request.project,
        request.permissions,
        request.providerSessionId
      );
    },

    async sendMessage(message: AgentMessageInput) {
      const session = sessions.get(message.sessionId);
      if (!session || !session.handle.isActive()) {
        return controlFailure<void>("invalid-session");
      }

      try {
        await session.handle.send(message.text);
      } catch {
        // The thrown value is deliberately not read. See `controlError`.
        return controlFailure<void>("unreachable");
      }

      return { ok: true, value: undefined };
    },

    async cancelRun(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) return controlFailure<void>("invalid-session");

      try {
        await session.handle.interrupt();
      } catch {
        return controlFailure<void>("unreachable");
      }

      emit({
        id: createId(),
        sessionId,
        provider: "claude-code",
        kind: "run_cancelled",
        timestamp: now(),
        summary: "Run cancelled.",
        ...(session.runId ? { runId: session.runId } : {}),
      });

      return { ok: true, value: undefined };
    },

    async respondToApproval(approvalId: string, decision: "granted" | "denied") {
      for (const session of sessions.values()) {
        const resolve = session.pending.get(approvalId);
        if (!resolve) continue;

        session.pending.delete(approvalId);
        pendingDetails.delete(approvalId);

        resolve(
          decision === "granted"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "You denied this action." }
        );

        return { ok: true, value: undefined };
      }

      // Unknown, already answered, or belonging to a session that has ended.
      return controlFailure<void>("invalid-request");
    },

    subscribeToEvents(listener: ControlEventListener): ControlUnsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    watchStatus(listener: ControlStatusListener): ControlUnsubscribe {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },

    dispose() {
      for (const session of sessions.values()) {
        void session.handle?.dispose();
        for (const resolve of session.pending.values()) {
          resolve({ behavior: "deny", message: "TabDump shut down." });
        }
      }
      sessions.clear();
      pendingDetails.clear();
      eventListeners.clear();
      statusListeners.clear();
    },

    takeApprovalDetails: (approvalId: string) => pendingDetails.get(approvalId),

    providerSessionIdFor: (sessionId: string) => sessions.get(sessionId)?.providerSessionId,

    bindRun(sessionId: string, runId: string) {
      const session = sessions.get(sessionId);
      if (session) session.runId = runId;
    },
  };
}

/** What the adapter knows about a pending approval, for the broker record. */
export type ClaudeApprovalDetails = {
  sessionId: string;
  runId?: string;
  toolName: string;
  scope: AgentPermissionScope;
  projectId?: string;
  targets: readonly string[];
  reason?: string;
};

/**
 * Reads the detail behind a pending approval, when the adapter is a Claude
 * Code one.
 *
 * A narrow, named accessor rather than a member on `AgentControlAdapter`: the
 * generic contract must not grow a provider-shaped method, and the service
 * calls this only after checking the adapter offers it.
 */
export function readApprovalDetails(
  adapter: AgentControlAdapter,
  approvalId: string
): ClaudeApprovalDetails | undefined {
  if (!hasApprovalDetails(adapter)) return undefined;
  return adapter.takeApprovalDetails(approvalId);
}

/** Whether this adapter carries the Claude-specific approval detail accessor. */
export function hasApprovalDetails(
  adapter: AgentControlAdapter
): adapter is ClaudeCodeControlAdapter {
  return (
    typeof (adapter as Partial<ClaudeCodeControlAdapter>).takeApprovalDetails === "function"
  );
}
