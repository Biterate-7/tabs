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
import type { AcpApprovalPolicy, AcpContextIdentity, AcpLauncher, AcpMcpServerEntry } from "./launcher";
import type { ToolPolicy } from "./policy";
import type { AcpPermissionRequest, AcpStopReason, AcpToolCall } from "./protocol";
import type { JsonRpcPeer, RpcFailure, RpcReply } from "./rpc";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import { authorizeContextRequest } from "@/lib/agents/session-context/authorization";
import type { ContextAuthority } from "@/lib/agents/session-context/authorization";

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
 * history, and reattaching a Hubble session to it is not built. Not
 * `additional_directories` — ACP has one working directory per session. Not
 * `mcp` — Hubble does not *grant* an ACP agent MCP tools. Any tool the agent
 * brings from its own configuration still has to ask (see `policy.ts`, kind
 * `other`) and is refused unless granted.
 *
 * ## Workspace context (Phase J.4)
 *
 * `workspace_context` is declared only for an agent whose launch entry has an
 * `exclusive-mcp` context identity. ACP's permission request names no MCP
 * server, so a Hubble context call is recognised structurally, never by name:
 * the agent was launched so that the session's context server is the only
 * MCP server it can load, and the request carries the option ids only that
 * agent's MCP confirmations carry. Such a request is answered by the one
 * shared decision (`authorizeContextRequest`) — allowed once, never always —
 * and the server then authorizes the actual tool, and raises a Hubble
 * approval for every write. A request without the marker is an ordinary tool.
 * An agent without such an identity is never handed the server at all.
 *
 * ## The approval model, end to end
 *
 *   1. The agent calls `session/request_permission` before a privileged tool.
 *   2. Hubble refuses at once if the grant does not include the tool's scope.
 *   3. Otherwise the adapter records the details and emits
 *      `approval_requested`; the service mints the broker record — the
 *      adapter cannot — and the user answers in the command centre.
 *   4. The answer goes back as the agent's own *one-time* option. Never
 *      "always": a standing grant inside the agent is one Hubble cannot see.
 *   5. **Enforcement.** A privileged tool the agent starts *without* an
 *      approval Hubble gave — an agent the user configured to auto-accept —
 *      makes the adapter cancel the turn and fail the session. An agent that
 *      does not ask is not an agent Hubble will drive.
 *
 * ## Modes (Phase J.2)
 *
 * Step 5 catches an agent *after* it has acted. Modes are how it is kept from
 * getting there. The launch entry's `AcpApprovalPolicy` names the modes in
 * which this agent asks before every privileged action. A session is started
 * only in one of them (refused with `approval-unenforceable` otherwise), and
 * a `current_mode_update` out of them stops the session at once. An agent
 * with no such mode declares no session capability at all, so the service
 * refuses its sessions without any provider-specific check.
 *
 * ## Sign-in state comes from the agent (Phase J.2)
 *
 * ACP has no "am I signed in" request, but it has a defined answer to
 * `session/new` when the agent is not: error `-32000`. `connect` therefore
 * asks — a `session/new` in an empty scratch directory, on the probe
 * connection, where no prompt is ever sent and every client request is
 * refused. Verified against Gemini CLI 0.61.0, codex-acp 1.13.1 and Grok
 * 1.0.41. The probe session is closed where the agent supports it, and a
 * signed-in probe connection is released at once.
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

/** An asking agent that can also carry the session's context server with a proven identity (J.4). */
export const ACP_CONTEXT_CAPABILITIES: AgentCapabilitySet = capabilitySet(
  "create_session",
  "message",
  "cancel_run",
  "stream_events",
  "approvals",
  "read_files",
  "write_files",
  "run_commands",
  "working_directory",
  "workspace_context"
);

/**
 * What an agent Hubble cannot hold to its approvals declares: nothing.
 * It can still be reached and signed in to; it cannot be given a session.
 */
export const ACP_REACH_ONLY_CAPABILITIES: AgentCapabilitySet = capabilitySet();

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
  /** Which modes ask before every privileged action, from the launch entry. Required: there is no default. */
  approval: AcpApprovalPolicy;
  /** How this agent's calls to the context server are proven (J.4), from the launch entry. Absent: never handed one. */
  contextIdentity?: AcpContextIdentity;
  now?: () => number;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type TrackedTool = {
  call: AcpToolCall;
  /** Hubble granted an approval for this call. */
  approved: boolean;
  started: boolean;
  finished: boolean;
  /** A call proven to be the session's context server's (J.4). */
  context?: boolean;
};

/** What a context call is shown as. It reads or proposes; the server decides which, per tool. */
const CONTEXT_TOOL_POLICY: ToolPolicy = {
  scope: "read_workspace",
  privileged: false,
  label: "Hubble",
  description: "Using your Hubble workspace",
  started: "tool_started",
  finished: "tool_finished",
};

/**
 * Whether a permission request is, structurally, a call to the one MCP server
 * this session could load — the context server (J.4). Kind `other` (an MCP
 * call's kind) and every option id the agent's MCP confirmations alone carry.
 * Never the title, never the tool's name.
 */
export function attestsContextCall(
  request: AcpPermissionRequest,
  identity: Extract<AcpContextIdentity, { kind: "exclusive-mcp" }>
): boolean {
  if (request.call.kind !== undefined && request.call.kind !== "other") return false;
  if (identity.mcpConfirmationOptionIds.length === 0) return false;
  return identity.mcpConfirmationOptionIds.every((optionId) =>
    request.options.some((option) => option.optionId === optionId)
  );
}

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
  acpSessionId: string;
  runId?: string;
  turn?: Turn;
  /** A prompt is in flight. */
  busy: boolean;
  segment: number;
  tools: Map<string, TrackedTool>;
  pending: Map<string, { request: AcpPermissionRequest; reply: (answer: RpcReply) => void }>;
  pendingContext?: readonly AgentContextAttachment[];
  /**
   * The modes this session may be in. Set once the session is in one of them;
   * from then on a `current_mode_update` to any other mode stops it.
   */
  askingModes?: readonly string[];
  /**
   * The session's context server (J.4): its identity, as launched exclusive,
   * and what the runtime established the session may do. Absent: no context.
   */
  context?: {
    identity: Extract<AcpContextIdentity, { kind: "exclusive-mcp" }>;
    authority: ContextAuthority;
  };
  ended: boolean;
};

/** The connection `connect()` opened, kept for sign-in. Separate from any session's. */
type Probe = { peer: JsonRpcPeer; release: () => void; cwd: string; sessionClose: boolean };

export type AcpControlAdapter = AgentControlAdapter & {
  takeApprovalDetails(approvalId: string): AdapterApprovalDetails | undefined;
  providerSessionIdFor(sessionId: string): string | undefined;
  bindRun(sessionId: string, runId: string): void;
  describeAuthentication(): AdapterAuthentication;
  authenticate(methodId: string): Promise<ControlResult<AdapterAuthentication>>;
  releaseSession(sessionId: string): void;
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
  let probe: Probe | undefined;
  const contextIdentity =
    options.contextIdentity?.kind === "exclusive-mcp" ? options.contextIdentity : undefined;
  const capabilities =
    options.approval.kind !== "asking-mode"
      ? ACP_REACH_ONLY_CAPABILITIES
      : contextIdentity
        ? ACP_CONTEXT_CAPABILITIES
        : ACP_CAPABILITIES;

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
    contextServerName: string | undefined,
    handlers: {
      onRequest: (method: string, params: unknown) => Promise<RpcReply> | RpcReply;
      onNotification: (method: string, params: unknown) => void;
      onClose: () => void;
    }
  ): Promise<
    | { ok: true; peer: JsonRpcPeer; cwd: string; release: () => void; mcpHttp: boolean; sessionClose: boolean }
    | { ok: false; code: ControlErrorCode }
  > {
    const launched = await options.launch({
      ...(projectPath ? { projectPath } : {}),
      ...(contextServerName ? { contextServerName } : {}),
    });
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
    return {
      ok: true,
      peer,
      cwd: launched.cwd,
      release: launched.release,
      mcpHttp: result.mcpHttp,
      sessionClose: result.sessionClose,
    };
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

    const policy = tracked.context ? CONTEXT_TOOL_POLICY : policyFor(merged.kind);
    const running = merged.status === "in_progress" || merged.status === "completed";

    if (running && policy.privileged && !tracked.approved) {
      enforce(session, "The agent acted without asking for approval, so Hubble stopped it.");
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
   * An agent ran a privileged tool Hubble never approved, or moved itself
   * into a mode where it would.
   *
   * The turn is cancelled and the session failed, with one fixed sentence
   * saying why. The user can start a new session, which Hubble puts back in
   * a mode where the agent asks.
   */
  function enforce(session: LiveSession, reason: string): void {
    if (session.ended) return;
    session.peer.notify("session/cancel", { sessionId: session.acpSessionId });
    emit(session, "error", reason);
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
      case "mode_changed":
        // Before the session settles into an asking mode, a report of the mode
        // it started in is expected and already being corrected. After, any
        // move out of the asking modes — by the agent, by a hook, by a user in
        // another client of the same agent — ends the session.
        if (session.askingModes && !session.askingModes.includes(read.update.modeId)) {
          enforce(session, "The agent switched to a mode where it approves its own actions, so Hubble stopped it.");
        }
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

    // The session's own context server (J.4), proven structurally — then the
    // one shared decision answers. Allowed once, never "always": each call
    // asks again, and the server authorizes the tool itself.
    if (session.context && attestsContextCall(request, session.context.identity)) {
      const decision = authorizeContextRequest(
        {
          sessionId: session.sessionId,
          provider,
          origin: "acp",
          serverName: session.context.authority.serverName,
        },
        session.context.authority
      );
      if (!decision.allowed) return { result: permissionOutcome(request, "denied") };
      const existing = session.tools.get(request.call.toolCallId);
      session.tools.set(request.call.toolCallId, {
        call: existing?.call ?? request.call,
        approved: true,
        started: existing?.started ?? false,
        finished: existing?.finished ?? false,
        context: true,
      });
      return { result: permissionOutcome(request, "granted") };
    }

    const known = session.tools.get(request.call.toolCallId)?.call;
    const kind = request.call.kind ?? known?.kind;
    const policy = policyFor(kind);
    const locations = request.call.locations.length > 0 ? request.call.locations : (known?.locations ?? []);

    // Hubble's own answer first. Asking about something the grant does not
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

  function releaseProbe(): void {
    const current = probe;
    probe = undefined;
    current?.peer.close();
    current?.release();
  }

  /**
   * Asks the agent whether it is signed in, in the one way ACP defines.
   *
   * A `session/new` on the probe connection: `-32000` is "sign in first", a
   * session id is "signed in", anything else is honestly `unknown`. The probe
   * connection refuses every request from the agent and never sends a
   * prompt, so nothing can run in it. A session it did create is closed when
   * the agent supports that, so connecting leaves nothing in its history.
   */
  async function askAuthentication(current: Probe): Promise<AdapterAuthenticationState> {
    const asked = await current.peer.request(
      "session/new",
      { cwd: current.cwd, mcpServers: [] },
      { timeoutMs: HANDSHAKE_TIMEOUT_MS }
    );
    if (!asked.ok) {
      return asked.kind === "remote" && asked.code === ACP_AUTH_REQUIRED ? "required" : "unknown";
    }
    const created = readNewSessionResult(asked.value);
    if (!created) return "unknown";
    if (current.sessionClose) {
      await current.peer.request("session/close", { sessionId: created.sessionId }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    }
    return "authenticated";
  }

  /**
   * Proves the agent can be launched and speaks ACP, learns how it signs in,
   * and asks it whether it is signed in. Opens no working session and runs
   * no tool.
   *
   * Asked again on every call, so signing in or out in a terminal is noticed
   * the next time the user presses Connect. A signed-out agent's connection is
   * kept so `authenticate` can use it; a signed-in one is released, since
   * nothing else needs it and the agent may hold processes of its own open.
   */
  async function connect(): Promise<ControlResult<ControlStatus>> {
    if (!probe?.peer.isOpen()) {
      setStatus({ kind: "connecting" });
      const opened = await open(undefined, undefined, {
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
      probe = { peer: opened.peer, release: opened.release, cwd: opened.cwd, sessionClose: opened.sessionClose };
    }

    const current = probe;
    if (!current) return controlFailure("unreachable");
    authState = await askAuthentication(current);
    if (authState === "authenticated" && probe === current) releaseProbe();
    setStatus({ kind: "connected" });
    return { ok: true, value: status };
  }

  async function settleAskingMode(
    peer: JsonRpcPeer,
    created: { sessionId: string; currentModeId?: string; availableModeIds: readonly string[] },
    askingModes: readonly string[]
  ): Promise<boolean> {
    if (created.currentModeId && askingModes.includes(created.currentModeId)) return true;
    const target = askingModes.find((modeId) => created.availableModeIds.includes(modeId));
    if (!target) return false;
    const moded = await peer.request(
      "session/set_mode",
      { sessionId: created.sessionId, modeId: target },
      { timeoutMs: HANDSHAKE_TIMEOUT_MS }
    );
    return moded.ok;
  }

  async function createSession(request: CreateSessionRequest): Promise<ControlResult<SessionHandle>> {
    if (sessions.has(request.sessionId)) return controlFailure("invalid-session");
    // The service never gets here for such an agent — it declares no
    // `create_session` — but the refusal is also the adapter's own, before
    // anything is launched.
    const approval = options.approval;
    if (approval.kind !== "asking-mode") return controlFailure("unsupported");

    // Filled once the session exists; the handlers only ever see it after.
    const live: { session?: LiveSession } = {};

    // The context server is handed over only with a proven identity (J.4):
    // the agent is launched limited to that one server. The service never
    // offers one to an adapter without `workspace_context`; if one arrives
    // anyway it is left out rather than attached unprovable.
    const contextServer = contextIdentity && request.contextServer ? request.contextServer : undefined;

    const opened = await open(request.project?.path, contextServer?.name, {
      onRequest,
      onNotification,
      onClose: () => {
        const session = live.session;
        if (!session || session.ended) return;
        // Said whether or not a turn was running: an agent that exits while
        // idle has ended the session just the same, and the service must hear
        // it — that is what ends the session's workspace credential (J.3). A
        // deliberate end marks the session ended before closing, so it is
        // never reported as unexpected.
        emit(session, "error", "Agent disconnected unexpectedly.");
        end(session);
      },
    });
    if (!opened.ok) return controlFailure(opened.code);

    // The session's own Hubble MCP server (J.3), for an agent that speaks
    // MCP over HTTP. Its credential travels in this request, over the agent's
    // stdin — never on a command line. Revoked by the runtime when the
    // session ends; this adapter holds nothing to release.
    const mcp: AcpMcpServerEntry | undefined =
      opened.mcpHttp && contextServer
        ? {
            type: "http",
            name: contextServer.name,
            url: contextServer.url,
            headers: [{ name: "Authorization", value: `Bearer ${contextServer.token}` }],
          }
        : undefined;

    const created = await opened.peer.request(
      "session/new",
      { cwd: opened.cwd, mcpServers: mcp ? [mcp] : [] },
      { timeoutMs: HANDSHAKE_TIMEOUT_MS }
    );
    const result = created.ok ? readNewSessionResult(created.value) : undefined;
    if (!result) {
      opened.peer.close();
      opened.release();
      return controlFailure(created.ok ? "malformed-response" : codeFor(created));
    }
    authState = "authenticated";

    const session: LiveSession = {
      sessionId: request.sessionId,
      ...(request.project ? { project: request.project } : {}),
      grant: request.permissions,
      peer: opened.peer,
      release: opened.release,
      acpSessionId: result.sessionId,
      busy: false,
      segment: 0,
      tools: new Map(),
      pending: new Map(),
      ...(request.attachments.length > 0 ? { pendingContext: request.attachments } : {}),
      ...(mcp && contextServer && contextIdentity
        ? {
            context: {
              identity: contextIdentity,
              authority: {
                sessionId: request.sessionId,
                workspaceId: contextServer.workspaceId,
                serverName: contextServer.name,
                capabilities: [...contextServer.capabilities],
              },
            },
          }
        : {}),
      ended: false,
    };
    live.session = session;
    sessions.set(request.sessionId, session);
    bySessionIdOfAgent.set(result.sessionId, session);

    // Put the agent in a mode where it asks. Already in one: nothing to do.
    // Offers one: switch to it. Offers none, or refuses the switch: the
    // session is not driven — Hubble does not start an agent that would be
    // approving its own actions, and does not guess at a mode it cannot see.
    const settled = await settleAskingMode(opened.peer, result, approval.modeIds);
    if (!settled) {
      end(session);
      sessions.delete(request.sessionId);
      return controlFailure("approval-unenforceable");
    }
    session.askingModes = approval.modeIds;

    setStatus({ kind: "connected" });
    emit(session, "session_started", mcp ? "Session started with Hubble tools." : "Session started.");
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

    getCapabilities: () => capabilities,

    getConnectionStatus: () => status,

    /**
     * Proves the agent can be launched and speaks ACP, and learns how it
     * signs in. Opens no session and runs no tool. The connection is kept so
     * `authenticate` can use it, and closed by `disconnect`.
     */
    connect,

    /**
     * Ends every session with this agent and lets go of the probe. The host
     * has already cancelled the runs; this is what ends the processes.
     */
    async disconnect() {
      for (const session of [...sessions.values()]) {
        end(session);
        sessions.delete(session.sessionId);
      }
      releaseProbe();
      if (status.kind !== "unavailable") setStatus({ kind: "disconnected" });
    },

    releaseSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      end(session);
      sessions.delete(sessionId);
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
      releaseProbe();
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
     * Hubble passes the method id and nothing else. For a browser method
     * the agent opens the provider's sign-in page on this machine; the
     * credential it obtains stays in the agent's own store.
     */
    async authenticate(methodId) {
      if (!authMethods.some((method) => method.id === methodId)) {
        return controlFailure("invalid-request");
      }
      if (!probe?.peer.isOpen()) {
        const connected = await connect();
        if (!connected.ok) return controlFailure("unreachable");
        // Signed in meanwhile — in a terminal, or another window.
        if (authState === "authenticated") return { ok: true, value: authentication() };
      }
      const current = probe;
      if (!current) return controlFailure("unreachable");
      const result = await current.peer.request(
        "authenticate",
        { methodId },
        { timeoutMs: AUTHENTICATE_TIMEOUT_MS }
      );
      if (!result.ok) {
        authState = "required";
        return controlFailure(codeFor(result) === "configuration" ? "configuration" : codeFor(result));
      }
      // The agent said the sign-in finished. It is asked once more, the same
      // way `connect` asks, so what Hubble shows is the agent's answer to
      // "can a session start now" rather than the sign-in flow's own report.
      // An agent that cannot answer is reported as exactly that — `unknown`,
      // which the UI shows as "could not be verified" — not as signed in.
      authState = await askAuthentication(current);
      if (authState === "authenticated" && probe === current) releaseProbe();
      if (authState === "required") return controlFailure("configuration");
      return { ok: true, value: authentication() };
    },
  };
}
