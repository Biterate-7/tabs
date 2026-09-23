import { capabilitySet } from "../../capabilities";
import { boundMessageText, MAX_CONTROL_DELTA_TEXT_LENGTH, normalizeControlSummary } from "../../events";
import { isGranted } from "../../permissions";
import { controlError, controlFailure } from "../../types";
import { withContext } from "../context-prompt";
import { policyFor, relativeLocations } from "./policy";
import {
  ACP_AUTH_REQUIRED,
  initializeParams,
  permissionOutcome,
  readInitializeResult,
  readNewSessionResult,
  readPermissionRequest,
  readSessionUpdate,
  readStopReason,
} from "./protocol";
import { createJsonRpcPeer, METHOD_NOT_FOUND } from "./rpc";
import type { AdapterApprovalDetails } from "../../approval-details";
import type {
  AdapterAuthentication,
  AdapterAuthMethod,
  AdapterAuthenticationState,
} from "../../authentication";
import type { AgentCapabilitySet } from "../../capabilities";
import type { AgentContextAttachment, AgentMessageInput } from "../../context";
import type { AgentControlEvent, AgentControlEventKind } from "../../events";
import type { AgentPermissionGrant } from "../../permissions";
import type { AgentProject } from "../../projects";
import type {
  AgentControlAdapter,
  ControlErrorCode,
  ControlEventListener,
  ControlResult,
  ControlStatus,
  ControlStatusListener,
  CreateSessionRequest,
  SessionHandle,
} from "../../types";
import type { AcpLauncher, AcpMcpLink, AcpMcpLinker } from "./launcher";
import type { AcpPermissionRequest, AcpStopReason, AcpToolCall } from "./protocol";
import type { JsonRpcPeer, RpcFailure, RpcReply } from "./rpc";
import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * One control adapter for every agent that speaks the Agent Client Protocol.
 *
 * ## Why one adapter and not three
 *
 * Gemini CLI, Grok Build and Codex (through `codex-acp`) all speak ACP. They
 * differ in how they are launched and how they sign in — both of which live
 * outside this file, in the server-side launcher and in the agent itself —
 * and not at all in how a session is driven. Writing three adapters would
 * mean three copies of the one part that is identical, drifting apart the
 * first time one was fixed.
 *
 * ## What it declares, and what it deliberately does not
 *
 * `create_session`, `message`, `cancel_run`, `stream_events`, `approvals`,
 * `read_files`, `write_files`, `run_commands`, `working_directory`. Each is
 * implemented below and exercised by `adapter.test.ts` against a scripted
 * ACP agent.
 *
 * Not `resume_session` — ACP's `session/load` exists but replays a whole
 * history, and reattaching a TabDump session to it is not built. Not
 * `additional_directories` — ACP has one working directory per session. Not
 * `mcp` — TabDump does not *grant* an ACP agent MCP tools; the one MCP server
 * it may attach is its own read-only one, and any tool the agent brings from
 * its own configuration still has to ask (see `policy.ts`, kind `other`).
 *
 * ## The approval model, end to end
 *
 *   1. The agent calls `session/request_permission` before a privileged tool.
 *   2. TabDump refuses at once if the grant does not include the tool's scope.
 *   3. Otherwise the adapter records the details and emits
 *      `approval_requested`; the service mints the broker record — the
 *      adapter cannot — and the user answers in the command centre.
 *   4. The answer goes back as the agent's own *one-time* option. Never
 *      "always": a standing grant inside the agent is one TabDump cannot see.
 *   5. **Enforcement.** A privileged tool the agent starts *without* an
 *      approval TabDump gave — an agent the user configured to auto-accept —
 *      makes the adapter cancel the turn and fail the session. An agent that
 *      does not ask is not an agent TabDump will drive.
 */

export const ACP_CAPABILITIES: AgentCapabilitySet = capabilitySet(
  "create_session",
  "message",
  "cancel_run",
  "stream_events",
  "approvals",
  "read_files",
  "write_files",
  "run_commands",
  "working_directory"
);

/** A prompt turn may legitimately run for a long time. It is ended by the user, not a clock. */
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Sign-in opens a browser and waits for a person. */
const AUTHENTICATE_TIMEOUT_MS = 10 * 60 * 1000;
/** Streamed text is coalesced into pieces no smaller than this, or older than the interval. */
const DELTA_FLUSH_CHARS = 600;
const DELTA_FLUSH_MS = 200;

export type AcpControlAdapterOptions = {
  provider: AgentProviderId;
  launch: AcpLauncher;
  /**
   * The mode to put a new session in, when the agent offers modes and this
   * one is among them. Chosen per provider as the one in which the agent
   * asks before editing or running anything. Absent: the agent's default.
   */
  askingModeId?: string;
  /** Per-session TabDump MCP access, when this runtime can mint it. */
  mcpLink?: AcpMcpLinker;
  now?: () => number;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type TrackedTool = {
  call: AcpToolCall;
  /** TabDump granted an approval for this call. */
  approved: boolean;
  started: boolean;
  finished: boolean;
};

type Turn = {
  messageId: string;
  text: string;
  unsent: string;
  flushTimer?: unknown;
  sawThought: boolean;
};

type LiveSession = {
  sessionId: string;
  project?: AgentProject;
  grant: AgentPermissionGrant;
  peer: JsonRpcPeer;
  release: () => void;
  mcp?: AcpMcpLink;
  acpSessionId: string;
  runId?: string;
  turn?: Turn;
  /** A prompt is in flight. */
  busy: boolean;
  segment: number;
  tools: Map<string, TrackedTool>;
  pending: Map<string, { request: AcpPermissionRequest; reply: (answer: RpcReply) => void }>;
  pendingContext?: readonly AgentContextAttachment[];
  ended: boolean;
};

export type AcpControlAdapter = AgentControlAdapter & {
  takeApprovalDetails(approvalId: string): AdapterApprovalDetails | undefined;
  providerSessionIdFor(sessionId: string): string | undefined;
  bindRun(sessionId: string, runId: string): void;
  describeAuthentication(): AdapterAuthentication;
  authenticate(methodId: string): Promise<ControlResult<AdapterAuthentication>>;
};

export function createAcpControlAdapter(options: AcpControlAdapterOptions): AcpControlAdapter {
  const { provider } = options;
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const createId = options.createId ?? (() => `acp-${now().toString(36)}-${(counter++).toString(36)}`);
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const sessions = new Map<string, LiveSession>();
  const bySessionIdOfAgent = new Map<string, LiveSession>();
  const eventListeners = new Set<ControlEventListener>();
  const statusListeners = new Set<ControlStatusListener>();
  const pendingDetails = new Map<string, AdapterApprovalDetails>();

  let status: ControlStatus = { kind: "disconnected", since: now() };
  let authState: AdapterAuthenticationState = "unknown";
  let authMethods: readonly AdapterAuthMethod[] = [];
  /** The connection `connect()` opened, kept for sign-in. Separate from any session's. */
  let probe: { peer: JsonRpcPeer; release: () => void } | undefined;

  function setStatus(next: Omit<ControlStatus, "since">): void {
    status = { ...next, since: now() };
    for (const listener of [...statusListeners]) listener(status);
  }

  function emit(
    session: LiveSession,
    kind: AgentControlEventKind,
    summary: string,
    extra: Partial<AgentControlEvent> = {}
  ): void {
    const event: AgentControlEvent = {
      id: createId(),
      sessionId: session.sessionId,
      provider,
      kind,
      timestamp: now(),
      summary: normalizeControlSummary(summary),
      ...(session.runId ? { runId: session.runId } : {}),
      ...extra,
    };
    for (const listener of [...eventListeners]) listener(event);
  }

  function authentication(): AdapterAuthentication {
    return { state: authState, methods: authMethods };
  }

  /* ---------------------------------------------------------------- *
   * Connection
   * ---------------------------------------------------------------- */

  /**
   * Launches the agent and completes the ACP handshake.
   *
   * Every failure maps to a code; nothing the agent printed is kept.
   */
  async function open(
    projectPath: string | undefined,
    handlers: {
      onRequest: (method: string, params: unknown) => Promise<RpcReply> | RpcReply;
      onNotification: (method: string, params: unknown) => void;
      onClose: () => void;
    }
  ): Promise<
    | { ok: true; peer: JsonRpcPeer; cwd: string; release: () => void; mcpHttp: boolean }
    | { ok: false; code: ControlErrorCode }
  > {
    const launched = await options.launch(projectPath ? { projectPath } : {});
    if (!launched.ok) {
      if (launched.reason === "not-installed") {
        setStatus({ kind: "unavailable", detail: "This agent is not installed on this machine." });
      }
      return { ok: false, code: "unreachable" };
    }

    const peer = createJsonRpcPeer({
      transport: launched.transport,
      onRequest: handlers.onRequest,
      onNotification: handlers.onNotification,
      onClose: handlers.onClose,
      setTimer,
      clearTimer,
    });

    const initialized = await peer.request("initialize", initializeParams(), {
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    const result = initialized.ok ? readInitializeResult(initialized.value) : undefined;
    if (!result) {
      peer.close();
      launched.release();
      return { ok: false, code: initialized.ok ? "malformed-response" : codeFor(initialized) };
    }

    authMethods = result.authMethods;
    return { ok: true, peer, cwd: launched.cwd, release: launched.release, mcpHttp: result.mcpHttp };
  }

  function codeFor(failure: RpcFailure): ControlErrorCode {
    if (failure.kind === "timeout") return "timeout";
    if (failure.kind === "closed") return "unreachable";
    if (failure.code === ACP_AUTH_REQUIRED) {
      authState = "required";
      return "configuration";
    }
    return "unknown";
  }

  /** Nothing a probe connection should answer: it never runs a tool. */
  function refuseRequest(): RpcReply {
    return { error: { code: METHOD_NOT_FOUND, message: "Method not found" } };
  }

  /* ---------------------------------------------------------------- *
   * Streaming
   * ---------------------------------------------------------------- */

  function turnFor(session: LiveSession): Turn {
    if (!session.turn) {
      session.segment += 1;
      session.turn = {
        messageId: `${session.sessionId}:m${session.segment}`,
        text: "",
        unsent: "",
        sawThought: false,
      };
    }
    return session.turn;
  }

  function flushDelta(session: LiveSession): void {
    const turn = session.turn;
    if (!turn) return;
    if (turn.flushTimer !== undefined) {
      clearTimer(turn.flushTimer);
      turn.flushTimer = undefined;
    }
    while (turn.unsent) {
      const piece = turn.unsent.slice(0, MAX_CONTROL_DELTA_TEXT_LENGTH);
      turn.unsent = turn.unsent.slice(piece.length);
      emit(session, "message_delta", piece, { text: piece, messageId: turn.messageId });
    }
  }

  /**
   * Ends the current message segment.
   *
   * Called when a tool starts and when the turn ends, so the chat shows the
   * agent's words, then what it did, then its next words — in the order they
   * happened rather than as one block after all the activity.
   */
  function closeSegment(session: LiveSession): void {
    const turn = session.turn;
    if (!turn) return;
    if (turn.flushTimer !== undefined) clearTimer(turn.flushTimer);
    session.turn = undefined;
    if (!turn.text.trim()) return;
    const text = boundMessageText(turn.text);
    emit(session, "message_received", text, { text, messageId: turn.messageId });
  }

  function onChunk(session: LiveSession, text: string): void {
    const turn = turnFor(session);
    turn.text += text;
    turn.unsent += text;
    if (turn.unsent.length >= DELTA_FLUSH_CHARS) {
      flushDelta(session);
      return;
    }
    if (turn.flushTimer === undefined) {
      turn.flushTimer = setTimer(() => {
        if (session.turn === turn) flushDelta(session);
      }, DELTA_FLUSH_MS);
    }
  }

  function onToolCall(session: LiveSession, call: AcpToolCall, isUpdate: boolean): void {
    const existing = session.tools.get(call.toolCallId);
    const merged: AcpToolCall = existing
      ? {
          ...existing.call,
          ...call,
          locations: call.locations.length > 0 ? call.locations : existing.call.locations,
          kind: call.kind ?? existing.call.kind,
        }
      : call;
    const tracked: TrackedTool = existing ?? { call: merged, approved: false, started: false, finished: false };
    tracked.call = merged;
    session.tools.set(call.toolCallId, tracked);

    if (!isUpdate || !existing) closeSegment(session);

    const policy = policyFor(merged.kind);
    const running = merged.status === "in_progress" || merged.status === "completed";

    if (running && policy.privileged && !tracked.approved) {
      enforce(session);
      return;
    }

    if (!tracked.started && merged.status !== "failed") {
      tracked.started = true;
      emit(session, policy.started, policy.description, {
        tool: { name: policy.label, description: policy.description, callId: merged.toolCallId },
      });
    }

    if (!tracked.finished && (merged.status === "completed" || merged.status === "failed")) {
      tracked.finished = true;
      const ok = merged.status === "completed";
      emit(session, policy.finished, ok ? `${policy.label} finished` : `${policy.label} failed`, {
        tool: { name: policy.label, callId: merged.toolCallId, ok },
      });
      if (ok && policy.fileKind && session.project) {
        for (const relativePath of relativeLocations(session.project.path, merged.locations)) {
          emit(session, policy.fileKind, relativePath, {
            file: { relativePath, projectId: session.project.id },
          });
        }
      }
    }
  }

  /**
   * An agent ran a privileged tool TabDump never approved.
   *
   * The turn is cancelled and the session failed, with one sentence saying
   * why. The user can start a new session once the agent is back in a mode
   * where it asks — which is the mode TabDump requests on every new session.
   */
  function enforce(session: LiveSession): void {
    if (session.ended) return;
    session.peer.notify("session/cancel", { sessionId: session.acpSessionId });
    emit(session, "error", "The agent acted without asking for approval, so TabDump stopped it.");
    end(session);
  }

  function onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const read = readSessionUpdate(params);
    if (!read) return;
    const session = bySessionIdOfAgent.get(read.sessionId);
    if (!session || session.ended) return;

    switch (read.update.type) {
      case "message_chunk":
        onChunk(session, read.update.text);
        return;
      case "thought_chunk": {
        const turn = turnFor(session);
        if (!turn.sawThought) {
          turn.sawThought = true;
          emit(session, "thinking", "Thinking");
        }
        return;
      }
      case "tool_call":
        onToolCall(session, read.update.call, false);
        return;
      case "tool_call_update":
        onToolCall(session, read.update.call, true);
        return;
    }
  }

  /* ---------------------------------------------------------------- *
   * Permissions
   * ---------------------------------------------------------------- */

  function onPermission(params: unknown): Promise<RpcReply> | RpcReply {
    const request = readPermissionRequest(params);
    const session = request ? bySessionIdOfAgent.get(request.sessionId) : undefined;
    if (!request || !session || session.ended) {
      return { result: { outcome: { outcome: "cancelled" } } };
    }

    const known = session.tools.get(request.call.toolCallId)?.call;
    const kind = request.call.kind ?? known?.kind;
    const policy = policyFor(kind);
    const locations = request.call.locations.length > 0 ? request.call.locations : (known?.locations ?? []);

    // TabDump's own answer first. Asking about something the grant does not
    // allow anyway would teach people to click through prompts.
    if (policy.forbidden || !isGranted(session.grant, policy.scope, session.project?.id)) {
      return { result: permissionOutcome(request, "denied") };
    }

    const approvalId = createId();
    const targets = relativeLocations(session.project?.path, locations);

    pendingDetails.set(approvalId, {
      sessionId: session.sessionId,
      ...(session.runId ? { runId: session.runId } : {}),
      ...(policy.action ? { action: policy.action } : {}),
      scope: policy.scope,
      ...(session.project ? { projectId: session.project.id } : {}),
      targets: targets.length > 0 ? targets : [policy.label],
      reason: policy.description,
    });

    // Registered before the event, for the reason the Claude adapter gives:
    // the service may answer synchronously inside `emit`.
    const answer = new Promise<RpcReply>((resolve) => {
      session.pending.set(approvalId, { request, reply: resolve });
    });

    emit(session, "approval_requested", policy.description, {
      approvalId,
      tool: { name: policy.label, callId: request.call.toolCallId },
    });

    return answer;
  }

  function onRequest(method: string, params: unknown): Promise<RpcReply> | RpcReply {
    if (method === "session/request_permission") return onPermission(params);
    // fs/* and terminal/* were never advertised. Refused, not implemented.
    return refuseRequest();
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  function end(session: LiveSession): void {
    if (session.ended) return;
    session.ended = true;
    if (session.turn?.flushTimer !== undefined) clearTimer(session.turn.flushTimer);
    session.turn = undefined;
    for (const [approvalId, pending] of session.pending) {
      pendingDetails.delete(approvalId);
      pending.reply({ result: permissionOutcome(pending.request, "cancelled") });
    }
    session.pending.clear();
    bySessionIdOfAgent.delete(session.acpSessionId);
    session.peer.close();
    session.release();
    session.mcp?.release();
  }

  function finishTurn(session: LiveSession, reason: AcpStopReason | undefined): void {
    session.busy = false;
    closeSegment(session);
    if (reason === "cancelled") {
      emit(session, "run_cancelled", "Run cancelled.");
      return;
    }
    const summary =
      reason === "max_tokens"
        ? "Stopped at the agent's length limit."
        : reason === "max_turn_requests"
          ? "Stopped at the agent's step limit."
          : reason === "refusal"
            ? "The agent declined to continue."
            : "Finished.";
    emit(session, "run_completed", summary);
  }

  /**
   * Proves the agent can be launched and speaks ACP, and learns how it signs
   * in. Opens no session and runs no tool. The connection is kept so
   * `authenticate` can use it, and closed by `disconnect`.
   */
  async function connect(): Promise<ControlResult<ControlStatus>> {
    if (probe?.peer.isOpen()) return { ok: true, value: status };
    setStatus({ kind: "connecting" });
    const opened = await open(undefined, {
      onRequest: () => refuseRequest(),
      onNotification: () => {},
      onClose: () => {
        probe = undefined;
      },
    });
    if (!opened.ok) {
      if (status.kind === "connecting") {
        setStatus({ kind: "error", lastError: controlError(opened.code) });
      }
      return controlFailure(opened.code);
    }
    probe = { peer: opened.peer, release: opened.release };
    setStatus({ kind: "connected" });
    return { ok: true, value: status };
  }

  async function createSession(request: CreateSessionRequest): Promise<ControlResult<SessionHandle>> {
    if (sessions.has(request.sessionId)) return controlFailure("invalid-session");

    // Filled once the session exists; the handlers only ever see it after.
    const live: { session?: LiveSession } = {};

    const opened = await open(request.project?.path, {
      onRequest,
      onNotification,
      onClose: () => {
        const session = live.session;
        if (!session || session.ended) return;
        if (session.busy) emit(session, "error", "The agent stopped unexpectedly.");
        end(session);
      },
    });
    if (!opened.ok) return controlFailure(opened.code);

    const mcp = opened.mcpHttp && options.mcpLink ? await options.mcpLink({ sessionId: request.sessionId }) : undefined;

    const created = await opened.peer.request(
      "session/new",
      { cwd: opened.cwd, mcpServers: mcp ? [mcp.server] : [] },
      { timeoutMs: HANDSHAKE_TIMEOUT_MS }
    );
    const result = created.ok ? readNewSessionResult(created.value) : undefined;
    if (!result) {
      opened.peer.close();
      opened.release();
      mcp?.release();
      return controlFailure(created.ok ? "malformed-response" : codeFor(created));
    }
    authState = "authenticated";

    const session: LiveSession = {
      sessionId: request.sessionId,
      ...(request.project ? { project: request.project } : {}),
      grant: request.permissions,
      peer: opened.peer,
      release: opened.release,
      ...(mcp ? { mcp } : {}),
      acpSessionId: result.sessionId,
      busy: false,
      segment: 0,
      tools: new Map(),
      pending: new Map(),
      ...(request.attachments.length > 0 ? { pendingContext: request.attachments } : {}),
      ended: false,
    };
    live.session = session;
    sessions.set(request.sessionId, session);
    bySessionIdOfAgent.set(result.sessionId, session);

    // Put the agent in the mode where it asks, when it offers one. A mode it
    // does not offer is left alone rather than guessed at.
    const asking = options.askingModeId;
    if (asking && result.currentModeId !== asking && result.availableModeIds.includes(asking)) {
      const moded = await opened.peer.request(
        "session/set_mode",
        { sessionId: result.sessionId, modeId: asking },
        { timeoutMs: HANDSHAKE_TIMEOUT_MS }
      );
      if (!moded.ok) {
        // An agent that will not enter the asking mode is not driven.
        end(session);
        sessions.delete(request.sessionId);
        return controlFailure("unknown");
      }
    }

    setStatus({ kind: "connected" });
    emit(session, "session_started", mcp ? "Session started with TabDump tools." : "Session started.");
    return { ok: true, value: { sessionId: request.sessionId, providerSessionId: result.sessionId, status: "ready" } };
  }

  async function sendMessage(message: AgentMessageInput): Promise<ControlResult<void>> {
    const session = sessions.get(message.sessionId);
    if (!session || session.ended) return controlFailure("invalid-session");
    if (session.busy) return controlFailure("invalid-session");

    const owed = [...(session.pendingContext ?? []), ...message.context.attachments];
    const seen = new Set<string>();
    const attachments = owed.filter((attachment) => {
      const key = `${attachment.kind}:${attachment.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    delete session.pendingContext;

    session.busy = true;
    const sent = session.peer.request(
      "session/prompt",
      {
        sessionId: session.acpSessionId,
        prompt: [{ type: "text", text: withContext(message.text, attachments) }],
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    );

    // Not awaited: the turn streams back through `session/update`, and its
    // end arrives as this response. The command returns as soon as the
    // message is on its way, exactly as the Claude adapter's does.
    void sent.then((result) => {
      if (session.ended) return;
      if (result.ok) {
        finishTurn(session, readStopReason(result.value));
        return;
      }
      session.busy = false;
      closeSegment(session);
      const code = codeFor(result);
      emit(
        session,
        "error",
        code === "configuration"
          ? "The agent needs to be signed in again."
          : controlError(code).message
      );
    });

    return { ok: true, value: undefined };
  }

  async function cancelRun(sessionId: string): Promise<ControlResult<void>> {
    const session = sessions.get(sessionId);
    if (!session || session.ended) return controlFailure("invalid-session");
    // Outstanding approvals are answered "cancelled" first so the agent is
    // not left blocked on a question while it is being told to stop.
    for (const [approvalId, pending] of session.pending) {
      pendingDetails.delete(approvalId);
      pending.reply({ result: permissionOutcome(pending.request, "cancelled") });
    }
    session.pending.clear();
    session.peer.notify("session/cancel", { sessionId: session.acpSessionId });
    return { ok: true, value: undefined };
  }

  async function respondToApproval(
    approvalId: string,
    decision: "granted" | "denied"
  ): Promise<ControlResult<void>> {
    for (const session of sessions.values()) {
      const pending = session.pending.get(approvalId);
      if (!pending) continue;
      session.pending.delete(approvalId);
      pendingDetails.delete(approvalId);
      if (decision === "granted") {
        const tracked = session.tools.get(pending.request.call.toolCallId);
        if (tracked) tracked.approved = true;
        else {
          session.tools.set(pending.request.call.toolCallId, {
            call: pending.request.call,
            approved: true,
            started: false,
            finished: false,
          });
        }
      }
      pending.reply({ result: permissionOutcome(pending.request, decision) });
      return { ok: true, value: undefined };
    }
    return controlFailure("invalid-session");
  }

  return {
    provider,

    getCapabilities: () => ACP_CAPABILITIES,

    getConnectionStatus: () => status,

    /**
     * Proves the agent can be launched and speaks ACP, and learns how it
     * signs in. Opens no session and runs no tool. The connection is kept so
     * `authenticate` can use it, and closed by `disconnect`.
     */
    connect,

    async disconnect() {
      probe?.peer.close();
      probe?.release();
      probe = undefined;
      if (status.kind !== "unavailable") setStatus({ kind: "disconnected" });
    },

    createSession,

    resumeSession: async () => controlFailure("unsupported"),

    sendMessage,

    cancelRun,

    respondToApproval,

    subscribeToEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    watchStatus(listener) {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },

    dispose() {
      for (const session of sessions.values()) end(session);
      sessions.clear();
      probe?.peer.close();
      probe?.release();
      probe = undefined;
      eventListeners.clear();
      statusListeners.clear();
    },

    takeApprovalDetails(approvalId) {
      return pendingDetails.get(approvalId);
    },

    providerSessionIdFor(sessionId) {
      return sessions.get(sessionId)?.acpSessionId;
    },

    bindRun(sessionId, runId) {
      const session = sessions.get(sessionId);
      if (session) session.runId = runId;
    },

    describeAuthentication: authentication,

    /**
     * Runs the agent's own sign-in for a method it advertised.
     *
     * TabDump passes the method id and nothing else. For a browser method
     * the agent opens the provider's sign-in page on this machine; the
     * credential it obtains stays in the agent's own store.
     */
    async authenticate(methodId) {
      if (!authMethods.some((method) => method.id === methodId)) {
        return controlFailure("invalid-request");
      }
      if (!probe?.peer.isOpen()) {
        const connected = await connect();
        if (!connected.ok || !probe) return controlFailure("unreachable");
      }
      const result = await probe.peer.request(
        "authenticate",
        { methodId },
        { timeoutMs: AUTHENTICATE_TIMEOUT_MS }
      );
      if (!result.ok) {
        authState = "required";
        return controlFailure(codeFor(result) === "configuration" ? "configuration" : codeFor(result));
      }
      authState = "authenticated";
      return { ok: true, value: authentication() };
    },
  };
}
