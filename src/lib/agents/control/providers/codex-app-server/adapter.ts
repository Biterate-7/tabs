import { capabilitySet } from "../../capabilities";
import { readCommandPreview } from "../../command-preview";
import { boundMessageText, MAX_CONTROL_DELTA_TEXT_LENGTH, normalizeControlSummary } from "../../events";
import { isGranted } from "../../permissions";
import { controlError, controlFailure } from "../../types";
import { createJsonRpcPeer, METHOD_NOT_FOUND } from "../acp/rpc";
import { withContext } from "../context-prompt";
import {
  commandDecision,
  elicitationDecision,
  FORBIDDEN_ITEM_TYPES,
  GATED_ITEM_TYPES,
  initializeParams,
  isVersionAtLeast,
  parseVersion,
  readAccount,
  readCommandApproval,
  readErrorNotification,
  readFileChangeApproval,
  readInitializeVersion,
  readItemDelta,
  readItemNotification,
  readItemRef,
  readSettingsUpdate,
  readThreadStart,
  readToolCallElicitation,
  readTurnCompleted,
  readTurnStart,
  threadStartParams,
  turnStartParams,
} from "./protocol";
import type { AdapterApprovalDetails, ApprovalAction } from "../../approval-details";
import type { AdapterAuthentication, AdapterAuthMethod } from "../../authentication";
import type { AgentCapabilitySet } from "../../capabilities";
import type { ApprovalCommandPreview } from "../../command-preview";
import type { AgentContextAttachment, AgentMessageInput } from "../../context";
import type { AgentControlEvent, AgentControlEventKind } from "../../events";
import type { AgentPermissionGrant, AgentPermissionScope } from "../../permissions";
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
import type { JsonRpcPeer, RpcFailure, RpcReply } from "../acp/rpc";
import type { AppServerLauncher, AppServerLaunchFailure, AppServerLogin } from "./launcher";
import type { CodexAccountAnswer, CodexFileChange, CodexItem, CodexVersion } from "./protocol";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import { toProjectRelative } from "@/lib/agents/paths";
import { authorizeContextRequest } from "@/lib/agents/session-context/authorization";
import type { ContextAuthority } from "@/lib/agents/session-context/authorization";

/**
 * Codex, driven directly through its own app-server (docs/codex-app-server.md).
 *
 * ## The trust model, said first
 *
 * Hubble's model for Codex is Claude Code's: **Codex proposes, the user
 * approves, and only then does Codex act.** It is not a sandbox. On Windows
 * Codex cannot confine an approved command to the project — verified against
 * 0.159.0, its sandbox refuses any profile that limits reads, under every
 * backend — so an approved command runs with the user's own permissions. That
 * is why the approval carries the complete command, and why the product says
 * so plainly wherever Codex is offered.
 *
 * ## How "only then" is made true
 *
 * Three layers, each verified against the real app-server:
 *
 *   1. **Launch** (lib/agents/launch/allowlist.ts): every Codex surface that
 *      could act without asking is switched off — interactive terminals
 *      (`write_stdin` into an approved shell ran further input unasked),
 *      `view_image` (read images anywhere unasked), web search, sub-agents,
 *      apps, plugins, hooks, computer and browser use. Codex runs in a
 *      settings folder Hubble owns, so no user rule approves a command unasked
 *      and no user MCP server starts.
 *   2. **Settings, on every thread and every turn** (./protocol.ts):
 *      `untrusted` + reviewer `user` + read-only. Codex's reply is checked;
 *      a thread that did not apply them is never driven, and a later
 *      `thread/settings/updated` out of them stops the session.
 *   3. **Enforcement**, here: a command, file change or MCP call that runs
 *      without an approval Hubble gave — output from it, or its completion —
 *      and any item of a switched-off kind, stops the session at once.
 *      Declined items never run and are not violations.
 *
 * ## Approvals
 *
 *   - `item/commandExecution/requestApproval` → a `run_command` approval in
 *     Hubble's broker, carrying the command line exactly as Codex will run it,
 *     its working directory, and any network destination. The answer goes
 *     back as `accept` or `decline` — never `acceptForSession`, never an
 *     execpolicy amendment.
 *   - `item/fileChange/requestApproval` → `modify_files` / `create_files` /
 *     `delete_files` over the paths Codex reported, all inside the project,
 *     or declined.
 *   - `mcpServer/elicitation/request` for a tool call on this session's
 *     context server → the shared context decision (`authorizeContextRequest`),
 *     allowed once; the context server raises a Hubble approval for every
 *     write. For any other server → declined.
 *   - Anything else Codex asks — more permissions, user input, a dynamic
 *     tool, a token refresh — is refused.
 *
 * ## Sign-in
 *
 * Asked of Codex itself (`account/read`) on a probe process that runs no
 * thread. Signing in runs Codex's own `codex login` (see the launcher), which
 * opens the browser and keeps the login in Codex's folder. Hubble never sees
 * the credential.
 */

export const CODEX_CAPABILITIES: AgentCapabilitySet = capabilitySet(
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

/** Where Hubble has not verified that Codex asks before every command: reached and signed in to, never given a session. */
export const CODEX_REACH_ONLY_CAPABILITIES: AgentCapabilitySet = capabilitySet();

const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Starting a thread may wait on its MCP server's startup. */
const THREAD_START_TIMEOUT_MS = 60_000;
const DELTA_FLUSH_CHARS = 600;
const DELTA_FLUSH_MS = 200;

export const CODEX_UNVERIFIED_PLATFORM_DETAIL =
  "Hubble has verified Codex's approvals on Windows only, so it does not start Codex sessions on this computer.";
export const CODEX_OLD_VERSION_DETAIL = "This version of Codex is older than the one Hubble supports. Update Codex, then try again.";
export const CODEX_UNSAFE_HOME_DETAIL =
  "Hubble's Codex folder holds approval rules or cannot be written, so Hubble did not start Codex.";

export type CodexControlAdapterOptions = {
  provider: AgentProviderId;
  launch: AppServerLauncher;
  login: AppServerLogin;
  /** Sign-in methods Hubble offers, from the allowlist's literal labels. */
  loginMethods: readonly AdapterAuthMethod[];
  /** Whether Hubble verified on this platform that Codex asks before every command. */
  platformVerified: boolean;
  /** The oldest Codex version verified, `major.minor.patch`. */
  minimumVersion: string;
  clientVersion?: string;
  now?: () => number;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type TrackedItem = {
  type: string;
  /** Hubble granted an approval for this item. */
  approved: boolean;
  /** The context server's call, authorized by the shared context decision. */
  context?: boolean;
  server?: string;
  changes?: CodexFileChange[];
  announced: boolean;
  finished: boolean;
};

type Segment = { itemId: string; messageId: string; text: string; unsent: string; flushTimer?: unknown };

type PendingApproval = { itemId: string; reply: (answer: RpcReply) => void; kind: "command" | "file" };

type LiveSession = {
  sessionId: string;
  project?: AgentProject;
  grant: AgentPermissionGrant;
  peer: JsonRpcPeer;
  release: () => void;
  threadId: string;
  runId?: string;
  turnId?: string;
  busy: boolean;
  segmentCount: number;
  segment?: Segment;
  sawThought: boolean;
  items: Map<string, TrackedItem>;
  pending: Map<string, PendingApproval>;
  pendingContext?: readonly AgentContextAttachment[];
  context?: ContextAuthority;
  ended: boolean;
};

export type CodexControlAdapter = AgentControlAdapter & {
  takeApprovalDetails(approvalId: string): AdapterApprovalDetails | undefined;
  providerSessionIdFor(sessionId: string): string | undefined;
  bindRun(sessionId: string, runId: string): void;
  describeAuthentication(): AdapterAuthentication;
  authenticate(methodId: string): Promise<ControlResult<AdapterAuthentication>>;
  releaseSession(sessionId: string): void;
};

/** What a command's working directory is called on the approval card. */
function workingDirectoryOf(project: AgentProject, cwd: string): { workingDirectory: string; insideProject: boolean } {
  const relative = toProjectRelative(project.path, cwd);
  if (relative.ok) return { workingDirectory: relative.relativePath, insideProject: true };
  // `empty` is the project root itself.
  if (relative.reason === "empty") return { workingDirectory: ".", insideProject: true };
  return { workingDirectory: cwd, insideProject: false };
}

function fileAction(changes: readonly CodexFileChange[]): ApprovalAction {
  if (changes.some((change) => change.kind === "delete")) return "delete_files";
  if (changes.every((change) => change.kind === "add")) return "create_files";
  return "modify_files";
}

export function createCodexControlAdapter(options: CodexControlAdapterOptions): CodexControlAdapter {
  const { provider } = options;
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const createId = options.createId ?? (() => `codex-${now().toString(36)}-${(counter++).toString(36)}`);
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const minimumVersion: CodexVersion = parseVersion(options.minimumVersion) ?? [Number.MAX_SAFE_INTEGER, 0, 0];

  const sessions = new Map<string, LiveSession>();
  const byThread = new Map<string, LiveSession>();
  const eventListeners = new Set<ControlEventListener>();
  const statusListeners = new Set<ControlStatusListener>();
  const pendingDetails = new Map<string, AdapterApprovalDetails>();

  let status: ControlStatus = { kind: "disconnected", since: now() };
  let account: CodexAccountAnswer = { state: "unknown", permitted: false };
  const capabilities = options.platformVerified ? CODEX_CAPABILITIES : CODEX_REACH_ONLY_CAPABILITIES;

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
    return {
      state: account.state,
      methods: options.loginMethods,
      ...(account.kind ? { kind: account.kind } : {}),
      ...(account.state === "authenticated" && !account.permitted ? { issue: "method_not_permitted" as const } : {}),
    };
  }

  /* ---------------------------------------------------------------- *
   * Connection
   * ---------------------------------------------------------------- */

  function codeFor(failure: RpcFailure): ControlErrorCode {
    if (failure.kind === "timeout") return "timeout";
    if (failure.kind === "closed") return "unreachable";
    return "unknown";
  }

  function launchFailure(reason: AppServerLaunchFailure): ControlErrorCode {
    if (reason === "not-installed") {
      setStatus({ kind: "unavailable", detail: "This agent is not installed on this machine." });
      return "unreachable";
    }
    if (reason === "unsafe-home") {
      setStatus({ kind: "error", lastError: controlError("configuration"), detail: CODEX_UNSAFE_HOME_DETAIL });
      return "configuration";
    }
    return "unreachable";
  }

  /**
   * Launches `codex app-server`, completes the handshake and checks the
   * version. Every failure is a code; nothing Codex printed is kept.
   */
  async function open(
    projectPath: string | undefined,
    handlers: {
      onRequest: (method: string, params: unknown) => Promise<RpcReply> | RpcReply;
      onNotification: (method: string, params: unknown) => void;
      onClose: () => void;
    }
  ): Promise<
    { ok: true; peer: JsonRpcPeer; cwd: string; release: () => void } | { ok: false; code: ControlErrorCode }
  > {
    const launched = await options.launch(projectPath !== undefined ? { projectPath } : {});
    if (!launched.ok) return { ok: false, code: launchFailure(launched.reason) };

    const peer = createJsonRpcPeer({
      transport: launched.transport,
      onRequest: handlers.onRequest,
      onNotification: handlers.onNotification,
      onClose: handlers.onClose,
      setTimer,
      clearTimer,
    });

    const close = (code: ControlErrorCode) => {
      peer.close();
      launched.release();
      return { ok: false as const, code };
    };

    const initialized = await peer.request("initialize", initializeParams(options.clientVersion ?? "1.0.0"), {
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    if (!initialized.ok) return close(codeFor(initialized));
    const version = readInitializeVersion(initialized.value);
    if (!version) return close("malformed-response");
    if (!isVersionAtLeast(version, minimumVersion)) {
      setStatus({ kind: "unavailable", detail: CODEX_OLD_VERSION_DETAIL });
      return close("unsupported");
    }
    peer.notify("initialized", {});
    return { ok: true, peer, cwd: launched.cwd, release: launched.release };
  }

  /** Asks Codex whether it is signed in — `account/read`, whose default refreshes nothing. */
  async function readSignIn(peer: JsonRpcPeer): Promise<CodexAccountAnswer> {
    const asked = await peer.request("account/read", {}, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    return asked.ok ? readAccount(asked.value) : { state: "unknown", permitted: false };
  }

  /**
   * Proves Codex can be launched and speaks the protocol, and asks whether it
   * is signed in. Runs no thread. The probe process is released at once:
   * sign-in is Codex's own CLI, not this connection.
   */
  async function connect(): Promise<ControlResult<ControlStatus>> {
    setStatus({ kind: "connecting" });
    const opened = await open(undefined, {
      onRequest: () => ({ error: { code: METHOD_NOT_FOUND, message: "Method not found" } }),
      onNotification: () => {},
      onClose: () => {},
    });
    if (!opened.ok) {
      if (status.kind === "connecting") setStatus({ kind: "error", lastError: controlError(opened.code) });
      return controlFailure(opened.code);
    }
    account = await readSignIn(opened.peer);
    opened.peer.close();
    opened.release();
    setStatus(options.platformVerified ? { kind: "connected" } : { kind: "connected", detail: CODEX_UNVERIFIED_PLATFORM_DETAIL });
    return { ok: true, value: status };
  }

  /* ---------------------------------------------------------------- *
   * Streaming
   * ---------------------------------------------------------------- */

  function flushDelta(session: LiveSession): void {
    const segment = session.segment;
    if (!segment) return;
    if (segment.flushTimer !== undefined) {
      clearTimer(segment.flushTimer);
      segment.flushTimer = undefined;
    }
    while (segment.unsent) {
      const piece = segment.unsent.slice(0, MAX_CONTROL_DELTA_TEXT_LENGTH);
      segment.unsent = segment.unsent.slice(piece.length);
      emit(session, "message_delta", piece, { text: piece, messageId: segment.messageId });
    }
  }

  function segmentFor(session: LiveSession, itemId: string): Segment {
    if (session.segment?.itemId === itemId) return session.segment;
    closeSegment(session);
    session.segmentCount += 1;
    session.segment = { itemId, messageId: `${session.sessionId}:m${session.segmentCount}`, text: "", unsent: "" };
    return session.segment;
  }

  /** Ends the current message, with Codex's final text when it gave one. */
  function closeSegment(session: LiveSession, finalText?: string): void {
    const segment = session.segment;
    if (!segment) return;
    if (segment.flushTimer !== undefined) clearTimer(segment.flushTimer);
    session.segment = undefined;
    const text = finalText ?? segment.text;
    if (!text.trim()) return;
    const bounded = boundMessageText(text);
    emit(session, "message_received", bounded, { text: bounded, messageId: segment.messageId });
  }

  function onDelta(session: LiveSession, itemId: string, delta: string): void {
    const segment = segmentFor(session, itemId);
    segment.text += delta;
    segment.unsent += delta;
    if (segment.unsent.length >= DELTA_FLUSH_CHARS) {
      flushDelta(session);
      return;
    }
    if (segment.flushTimer === undefined) {
      segment.flushTimer = setTimer(() => {
        if (session.segment === segment) flushDelta(session);
      }, DELTA_FLUSH_MS);
    }
  }

  /* ---------------------------------------------------------------- *
   * Enforcement
   * ---------------------------------------------------------------- */

  /**
   * Codex acted without an approval Hubble gave, left the asking settings, or
   * used a surface Hubble switched off. The session is ended — its process
   * with it — with one fixed sentence saying why.
   */
  function enforce(session: LiveSession, reason: string): void {
    if (session.ended) return;
    emit(session, "error", reason);
    end(session);
  }

  const ACTED_UNASKED = "Codex acted without your approval, so Hubble stopped it.";

  function onItemStarted(session: LiveSession, item: CodexItem): void {
    if ((FORBIDDEN_ITEM_TYPES as readonly string[]).includes(item.type)) {
      enforce(session, "Codex tried to use a tool Hubble keeps switched off, so Hubble stopped it.");
      return;
    }
    if (item.type === "reasoning") {
      if (!session.sawThought) {
        session.sawThought = true;
        emit(session, "thinking", "Thinking");
      }
      return;
    }
    if (item.type === "agentMessage") {
      segmentFor(session, item.id);
      return;
    }
    if (!(GATED_ITEM_TYPES as readonly string[]).includes(item.type)) return;

    closeSegment(session);
    const existing = session.items.get(item.id);
    const tracked: TrackedItem = existing ?? { type: item.type, approved: false, announced: false, finished: false };
    if (item.server) tracked.server = item.server;
    if (item.changes) tracked.changes = item.changes;
    session.items.set(item.id, tracked);

    // A context call is announced as it starts; the call itself was asked
    // about (the elicitation follows), and the server decides it.
    if (item.type === "mcpToolCall" && session.context && item.server === session.context.serverName) {
      tracked.announced = true;
      emit(session, "tool_started", "Using your Hubble workspace", {
        tool: { name: "Hubble", description: "Using your Hubble workspace", callId: item.id },
      });
    }
  }

  function onItemCompleted(session: LiveSession, item: CodexItem): void {
    if ((FORBIDDEN_ITEM_TYPES as readonly string[]).includes(item.type)) {
      enforce(session, "Codex tried to use a tool Hubble keeps switched off, so Hubble stopped it.");
      return;
    }
    if (item.type === "agentMessage") {
      if (session.segment?.itemId !== item.id) segmentFor(session, item.id);
      closeSegment(session, item.text);
      return;
    }
    if (!(GATED_ITEM_TYPES as readonly string[]).includes(item.type)) return;

    const tracked = session.items.get(item.id) ?? {
      type: item.type,
      approved: false,
      announced: false,
      finished: false,
      ...(item.server ? { server: item.server } : {}),
      ...(item.changes ? { changes: item.changes } : {}),
    };
    session.items.set(item.id, tracked);
    if (tracked.finished) return;
    tracked.finished = true;

    // Declined: it never ran. Nothing to enforce and nothing to report —
    // the approval's own record says what the person decided.
    if (item.status === "declined") return;

    const ran =
      item.type === "mcpToolCall"
        ? // A failed MCP call without an approval is the server refusing it.
          item.status === "completed"
        : item.status === "completed" || item.status === "failed";
    if (ran && !tracked.approved) {
      enforce(session, ACTED_UNASKED);
      return;
    }

    const ok = item.status === "completed";
    switch (item.type) {
      case "commandExecution":
        if (tracked.approved) {
          emit(session, "command_finished", ok ? "Command finished" : "Command failed", {
            tool: { name: "Command", callId: item.id, ok },
          });
        }
        return;
      case "fileChange":
        if (!tracked.approved) return;
        emit(session, "tool_finished", ok ? "Edit finished" : "Edit failed", { tool: { name: "Edit", callId: item.id, ok } });
        if (ok && session.project) {
          for (const change of tracked.changes ?? []) {
            const relative = toProjectRelative(session.project.path, change.path);
            if (!relative.ok) continue;
            emit(session, change.kind === "add" ? "file_created" : "file_modified", relative.relativePath, {
              file: { relativePath: relative.relativePath, projectId: session.project.id },
            });
          }
        }
        return;
      case "mcpToolCall":
        if (tracked.announced) {
          emit(session, "tool_finished", ok ? "Hubble finished" : "Hubble failed", {
            tool: { name: "Hubble", callId: item.id, ok },
          });
        }
        return;
    }
  }

  /** Output from an item Hubble did not approve means it is running unasked. */
  function onOutput(session: LiveSession, itemId: string): void {
    if (!session.items.get(itemId)?.approved) enforce(session, ACTED_UNASKED);
  }

  function finishTurn(session: LiveSession, outcome: "completed" | "interrupted" | "failed", unauthorized: boolean): void {
    session.busy = false;
    session.turnId = undefined;
    session.sawThought = false;
    closeSegment(session);
    // A request Codex stopped waiting for is answered — declined — and said
    // so, so nothing lingers and the session is not left "waiting".
    for (const [approvalId, pending] of session.pending) {
      pendingDetails.delete(approvalId);
      pending.reply(declined());
      emit(session, "approval_denied", "Denied", { approvalId });
    }
    session.pending.clear();
    if (outcome === "interrupted") {
      emit(session, "run_cancelled", "Run cancelled.");
      return;
    }
    if (outcome === "failed") {
      if (unauthorized) account = { state: "required", permitted: false };
      emit(session, "error", unauthorized ? "The agent needs to be signed in again." : controlError("unknown").message);
      return;
    }
    emit(session, "run_completed", "Finished.");
  }

  function onNotification(method: string, params: unknown): void {
    switch (method) {
      case "item/started":
      case "item/completed": {
        const read = readItemNotification(params);
        const session = read ? byThread.get(read.threadId) : undefined;
        if (!read || !session || session.ended) return;
        if (method === "item/started") onItemStarted(session, read.item);
        else onItemCompleted(session, read.item);
        return;
      }
      case "item/agentMessage/delta": {
        const read = readItemDelta(params);
        const session = read ? byThread.get(read.threadId) : undefined;
        if (read && session && !session.ended) onDelta(session, read.itemId, read.delta);
        return;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/commandExecution/terminalInteraction": {
        const read = readItemRef(params);
        const session = read ? byThread.get(read.threadId) : undefined;
        if (read && session && !session.ended) onOutput(session, read.itemId);
        return;
      }
      case "turn/completed": {
        const read = readTurnCompleted(params);
        const session = read ? byThread.get(read.threadId) : undefined;
        if (read && session && !session.ended) finishTurn(session, read.status, read.unauthorized);
        return;
      }
      case "error": {
        const read = readErrorNotification(params);
        const session = read ? byThread.get(read.threadId) : undefined;
        if (read && session && !session.ended && read.unauthorized) account = { state: "required", permitted: false };
        return;
      }
      case "thread/settings/updated": {
        const read = readSettingsUpdate(params);
        const session = read ? byThread.get(read.threadId) : undefined;
        if (read && session && !session.ended && !read.asking) {
          enforce(session, "Codex's approval settings changed, so Hubble stopped it.");
        }
        return;
      }
      case "hook/started":
      case "item/autoApprovalReview/started": {
        // Something other than the person was about to act or decide.
        const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
        const session = typeof threadId === "string" ? byThread.get(threadId) : undefined;
        if (session && !session.ended) enforce(session, "Codex tried to use a tool Hubble keeps switched off, so Hubble stopped it.");
        return;
      }
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------- *
   * Requests Codex makes of Hubble
   * ---------------------------------------------------------------- */

  function raise(
    session: LiveSession,
    pending: Omit<PendingApproval, "reply">,
    details: Omit<AdapterApprovalDetails, "sessionId" | "runId" | "projectId">,
    label: string
  ): Promise<RpcReply> {
    const approvalId = createId();
    pendingDetails.set(approvalId, {
      sessionId: session.sessionId,
      ...(session.runId ? { runId: session.runId } : {}),
      ...(session.project ? { projectId: session.project.id } : {}),
      ...details,
    });
    // Registered before the event: the service may answer inside `emit`.
    const answer = new Promise<RpcReply>((resolve) => {
      session.pending.set(approvalId, { ...pending, reply: resolve });
    });
    emit(session, "approval_requested", label, { approvalId, tool: { name: label, callId: pending.itemId } });
    return answer;
  }

  function declined(): RpcReply {
    return { result: commandDecision(false) };
  }

  function onCommandApproval(params: unknown): Promise<RpcReply> | RpcReply {
    const request = readCommandApproval(params);
    const session = request ? byThread.get(request.threadId) : undefined;
    if (!request || !session || session.ended || !session.project) return declined();
    // Input to a running process is never approved: interactive terminals
    // are switched off, so this would be something Hubble cannot show.
    if (request.kind !== "command") return declined();
    if (!isGranted(session.grant, "run_commands", session.project.id)) return declined();

    const command: ApprovalCommandPreview | undefined = readCommandPreview({
      commandLine: request.command,
      ...workingDirectoryOf(session.project, request.cwd),
      ...(request.network ? { network: request.network } : {}),
    });
    // A command that cannot be shown whole is not put to anybody.
    if (!command) return declined();

    return raise(
      session,
      { itemId: request.itemId, kind: "command" },
      {
        action: "run_command",
        scope: "run_commands",
        targets: ["Command"],
        ...(request.reason ? { reason: request.reason } : {}),
        command,
      },
      "Command"
    );
  }

  function onFileChangeApproval(params: unknown): Promise<RpcReply> | RpcReply {
    const request = readFileChangeApproval(params);
    const session = request ? byThread.get(request.threadId) : undefined;
    if (!request || !session || session.ended || !session.project) return declined();
    // A standing write root for the rest of the session is not something
    // Hubble grants; each change asks.
    if (request.asksForRoot) return declined();
    if (!isGranted(session.grant, "write_project", session.project.id)) return declined();

    const changes = session.items.get(request.itemId)?.changes;
    if (!changes || changes.length === 0) return declined();
    const targets: string[] = [];
    for (const change of changes) {
      for (const path of change.movePath ? [change.path, change.movePath] : [change.path]) {
        const relative = toProjectRelative(session.project.path, path);
        // A change outside the project is outside the grant.
        if (!relative.ok) return declined();
        if (!targets.includes(relative.relativePath)) targets.push(relative.relativePath);
      }
    }

    const scope: AgentPermissionScope = "write_project";
    return raise(
      session,
      { itemId: request.itemId, kind: "file" },
      { action: fileAction(changes), scope, targets, ...(request.reason ? { reason: request.reason } : {}) },
      "Edit"
    );
  }

  function onElicitation(params: unknown): RpcReply {
    const request = readToolCallElicitation(params);
    const session = request ? byThread.get(request.threadId) : undefined;
    if (!request || !session || session.ended || !session.context) return { result: elicitationDecision(false) };

    // Only this session's own context server — named by Codex from its
    // configuration, which Hubble wrote for this thread alone.
    if (request.serverName !== session.context.serverName) return { result: elicitationDecision(false) };
    const decision = authorizeContextRequest(
      { sessionId: session.sessionId, provider, origin: "app-server", serverName: request.serverName },
      session.context
    );
    if (!decision.allowed) return { result: elicitationDecision(false) };

    // The call this answers: the oldest context call still waiting. Codex
    // reports the call before it asks about it (verified).
    const waiting = [...session.items.entries()].find(
      ([, tracked]) =>
        tracked.type === "mcpToolCall" && tracked.server === request.serverName && !tracked.approved && !tracked.finished
    );
    if (!waiting) return { result: elicitationDecision(false) };
    waiting[1].approved = true;
    waiting[1].context = true;
    return { result: elicitationDecision(true) };
  }

  function onRequest(method: string, params: unknown): Promise<RpcReply> | RpcReply {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return onCommandApproval(params);
      case "item/fileChange/requestApproval":
        return onFileChangeApproval(params);
      case "mcpServer/elicitation/request":
        return onElicitation(params);
      case "item/permissions/requestApproval":
        // More filesystem or network access for the rest of a turn: never.
        return { result: { permissions: {}, scope: "turn" } };
      case "execCommandApproval":
      case "applyPatchApproval":
        // The older protocol's approvals, which Hubble does not speak.
        return { result: { decision: "denied" } };
      default:
        // User input, dynamic tools, token refresh, attestation: refused.
        return { error: { code: METHOD_NOT_FOUND, message: "Method not found" } };
    }
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  function end(session: LiveSession): void {
    if (session.ended) return;
    session.ended = true;
    if (session.segment?.flushTimer !== undefined) clearTimer(session.segment.flushTimer);
    session.segment = undefined;
    for (const [approvalId, pending] of session.pending) {
      pendingDetails.delete(approvalId);
      pending.reply(declined());
    }
    session.pending.clear();
    byThread.delete(session.threadId);
    // Ends the process — and with it anything an approved command left running.
    session.peer.close();
    session.release();
  }

  async function createSession(request: CreateSessionRequest): Promise<ControlResult<SessionHandle>> {
    if (sessions.has(request.sessionId)) return controlFailure("invalid-session");
    // The service never gets here without `create_session`; refused here too.
    if (!options.platformVerified) return controlFailure("unsupported");

    const live: { session?: LiveSession } = {};
    const opened = await open(request.project?.path, {
      onRequest,
      onNotification,
      onClose: () => {
        const session = live.session;
        if (!session || session.ended) return;
        emit(session, "error", "Agent disconnected unexpectedly.");
        end(session);
      },
    });
    if (!opened.ok) return controlFailure(opened.code);

    const abandon = (code: ControlErrorCode) => {
      opened.peer.close();
      opened.release();
      return controlFailure<SessionHandle>(code);
    };

    // Signed in, with the sign-in Hubble uses — asked of Codex, before any thread.
    account = await readSignIn(opened.peer);
    if (account.state !== "authenticated" || !account.permitted) return abandon("configuration");

    const contextServer = request.contextServer;
    const started = await opened.peer.request(
      "thread/start",
      threadStartParams({
        cwd: opened.cwd,
        ...(contextServer ? { sessionServer: { name: contextServer.name, url: contextServer.url, token: contextServer.token } } : {}),
      }),
      { timeoutMs: THREAD_START_TIMEOUT_MS }
    );
    if (!started.ok) return abandon(codeFor(started));
    const thread = readThreadStart(started.value);
    if (!thread) return abandon("malformed-response");
    // Codex did not apply the asking settings: never driven.
    if (!thread.asking) return abandon("approval-unenforceable");

    const session: LiveSession = {
      sessionId: request.sessionId,
      ...(request.project ? { project: request.project } : {}),
      grant: request.permissions,
      peer: opened.peer,
      release: opened.release,
      threadId: thread.threadId,
      busy: false,
      segmentCount: 0,
      sawThought: false,
      items: new Map(),
      pending: new Map(),
      ...(request.attachments.length > 0 ? { pendingContext: request.attachments } : {}),
      ...(contextServer
        ? {
            context: {
              sessionId: request.sessionId,
              workspaceId: contextServer.workspaceId,
              serverName: contextServer.name,
              capabilities: [...contextServer.capabilities],
            },
          }
        : {}),
      ended: false,
    };
    live.session = session;
    sessions.set(request.sessionId, session);
    byThread.set(thread.threadId, session);

    setStatus({ kind: "connected" });
    emit(session, "session_started", contextServer ? "Session started with Hubble tools." : "Session started.");
    return { ok: true, value: { sessionId: request.sessionId, providerSessionId: thread.threadId, status: "ready" } };
  }

  async function sendMessage(message: AgentMessageInput): Promise<ControlResult<void>> {
    const session = sessions.get(message.sessionId);
    if (!session || session.ended || session.busy) return controlFailure("invalid-session");

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
    const started = await session.peer.request(
      "turn/start",
      turnStartParams(session.threadId, withContext(message.text, attachments)),
      { timeoutMs: HANDSHAKE_TIMEOUT_MS }
    );
    if (session.ended) return controlFailure("invalid-session");
    const turn = started.ok ? readTurnStart(started.value) : undefined;
    if (!turn) {
      session.busy = false;
      const code = started.ok ? "malformed-response" : codeFor(started);
      emit(session, "error", controlError(code).message);
      return controlFailure(code);
    }
    // The turn streams back as notifications and ends with `turn/completed`
    // — unless it already did while this reply was on its way.
    if (session.busy) session.turnId = turn.turnId;
    return { ok: true, value: undefined };
  }

  async function cancelRun(sessionId: string): Promise<ControlResult<void>> {
    const session = sessions.get(sessionId);
    if (!session || session.ended) return controlFailure("invalid-session");
    // Outstanding approvals are declined first, so nothing is left waiting on
    // a question while Codex is being told to stop.
    for (const [approvalId, pending] of session.pending) {
      pendingDetails.delete(approvalId);
      pending.reply(declined());
    }
    session.pending.clear();
    if (session.turnId) {
      await session.peer.request(
        "turn/interrupt",
        { threadId: session.threadId, turnId: session.turnId },
        { timeoutMs: HANDSHAKE_TIMEOUT_MS }
      );
    }
    return { ok: true, value: undefined };
  }

  async function respondToApproval(approvalId: string, decision: "granted" | "denied"): Promise<ControlResult<void>> {
    for (const session of sessions.values()) {
      const pending = session.pending.get(approvalId);
      if (!pending) continue;
      session.pending.delete(approvalId);
      pendingDetails.delete(approvalId);
      const granted = decision === "granted" && !session.ended;
      // The answer, as an event: it is what moves the session out of
      // "waiting for approval" — without it, the run's end would be refused
      // as a transition and the session would read as waiting forever.
      if (!session.ended) {
        emit(session, granted ? "approval_granted" : "approval_denied", granted ? "Approved" : "Denied", { approvalId });
      }
      if (granted) {
        const tracked = session.items.get(pending.itemId);
        if (tracked) tracked.approved = true;
        else session.items.set(pending.itemId, { type: pending.kind === "command" ? "commandExecution" : "fileChange", approved: true, announced: false, finished: false });
        if (pending.kind === "command") {
          emit(session, "command_started", "Running a command", {
            tool: { name: "Command", description: "Running a command", callId: pending.itemId },
          });
        } else {
          emit(session, "tool_started", "Editing files", {
            tool: { name: "Edit", description: "Editing files", callId: pending.itemId },
          });
        }
      }
      pending.reply({ result: commandDecision(granted) });
      return { ok: true, value: undefined };
    }
    return controlFailure("invalid-session");
  }

  return {
    provider,

    getCapabilities: () => capabilities,

    getConnectionStatus: () => status,

    connect,

    async disconnect() {
      for (const session of [...sessions.values()]) {
        end(session);
        sessions.delete(session.sessionId);
      }
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
      eventListeners.clear();
      statusListeners.clear();
    },

    takeApprovalDetails(approvalId) {
      return pendingDetails.get(approvalId);
    },

    providerSessionIdFor(sessionId) {
      return sessions.get(sessionId)?.threadId;
    },

    bindRun(sessionId, runId) {
      const session = sessions.get(sessionId);
      if (session) session.runId = runId;
    },

    describeAuthentication: authentication,

    /**
     * Runs Codex's own sign-in for a method Hubble offers, then asks Codex
     * again. Hubble passes the method id and nothing else; Codex opens the
     * browser and keeps the login.
     */
    async authenticate(methodId) {
      if (!options.loginMethods.some((method) => method.id === methodId)) return controlFailure("invalid-request");
      const outcome = await options.login(methodId);
      if (outcome === "unavailable") return controlFailure("unreachable");
      if (outcome === "timeout") return controlFailure("timeout");
      // Asked again either way: a sign-in that "failed" may have been
      // finished in another window, and a "completed" one is proven by Codex's
      // own answer, not the sign-in program's exit code.
      const connected = await connect();
      if (!connected.ok) return controlFailure(connected.error.code);
      if (account.state !== "authenticated") return controlFailure("configuration");
      return { ok: true, value: authentication() };
    },
  };
}

