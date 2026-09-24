/**
 * The slice of the Agent Client Protocol TabDump speaks, read defensively.
 *
 * ACP (agentclientprotocol.com) is JSON-RPC 2.0 over stdio, protocol version
 * 1. It is spoken natively by Gemini CLI (`gemini --acp`) and Grok Build
 * (`grok agent stdio`), and by Codex through the `codex-acp` adapter — which
 * is why TabDump implements it once, here, rather than three provider
 * integrations. The launch vocabulary for each lives server-side in
 * `lib/agents/launch/allowlist.ts`; this file never names a binary.
 *
 * ## What TabDump advertises, and why so little
 *
 * `clientCapabilities` declares **no** filesystem and **no** terminal. ACP
 * lets a client offer to read and write files and to run commands *for* the
 * agent; TabDump offering either would make it the thing that executes, which
 * the whole architecture refuses. The agent uses its own tools inside the
 * directory TabDump launched it in, and asks — through
 * `session/request_permission` — before anything privileged. An `fs/*` or
 * `terminal/*` request that arrives anyway is answered method-not-found.
 *
 * ## Every field is optional until proven otherwise
 *
 * Agents add fields and variants with every release. Each reader below takes
 * `unknown`, returns `undefined` for a shape it does not recognise, and keeps
 * only the fields TabDump uses. A new update kind is ignored rather than
 * breaking the stream.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** The error code ACP agents use for "authenticate first". */
export const ACP_AUTH_REQUIRED = -32000;

export const ACP_CLIENT_INFO = { name: "tabdump", title: "TabDump", version: "1.0.0" } as const;

export function initializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: ACP_CLIENT_INFO,
  };
}

/* ------------------------------------------------------------------ *
 * Readers
 * ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collapses and bounds an agent-supplied label. It is shown, never interpreted. */
export function cleanLabel(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export type AcpAuthMethod = { id: string; name: string; description?: string };

export type AcpInitializeResult = {
  protocolVersion: number;
  loadSession: boolean;
  mcpHttp: boolean;
  /** The agent can close a session it created (`session/close`). */
  sessionClose: boolean;
  authMethods: readonly AcpAuthMethod[];
};

/** At most this many sign-in methods are carried to a UI. */
export const MAX_AUTH_METHODS = 8;

/**
 * Whether a sign-in method is one the agent completes on its own.
 *
 * Verified against the real agents: Gemini CLI advertises `oauth-personal`,
 * `gemini-api-key`, `vertex-ai` and `gateway`; codex-acp advertises
 * `chat-gpt` and `api-key`. The key and gateway methods read a key from the
 * agent's environment — and TabDump starts agents with an allowlisted
 * environment that carries no key (lib/agents/launch/env.ts), on purpose. So
 * those methods cannot succeed from here, and offering them as buttons would
 * be offering a failure. What is left is the agent's own interactive login.
 */
export function isInteractiveAuthMethod(method: AcpAuthMethod): boolean {
  const text = `${method.id} ${method.name} ${method.description ?? ""}`;
  return !/api[\s_-]?key|gateway/i.test(text);
}

export function readInitializeResult(value: unknown): AcpInitializeResult | undefined {
  const result = record(value);
  if (!result || typeof result.protocolVersion !== "number") return undefined;

  const capabilities = record(result.agentCapabilities);
  const mcp = record(capabilities?.mcpCapabilities);
  const sessionCapabilities = record(capabilities?.sessionCapabilities);

  const authMethods: AcpAuthMethod[] = [];
  for (const raw of list(result.authMethods)) {
    const method = record(raw);
    const id = cleanLabel(str(method?.id), 100);
    const name = cleanLabel(str(method?.name), 80);
    if (!id || !name) continue;
    const description = cleanLabel(str(method?.description), 200);
    const entry = { id, name, ...(description ? { description } : {}) };
    if (!isInteractiveAuthMethod(entry)) continue;
    authMethods.push(entry);
    if (authMethods.length >= MAX_AUTH_METHODS) break;
  }

  return {
    protocolVersion: result.protocolVersion,
    loadSession: capabilities?.loadSession === true,
    mcpHttp: mcp?.http === true,
    sessionClose: record(sessionCapabilities?.close) !== undefined,
    authMethods,
  };
}

export type AcpSessionMode = { id: string };

export type AcpNewSessionResult = {
  sessionId: string;
  currentModeId?: string;
  availableModeIds: readonly string[];
};

export function readNewSessionResult(value: unknown): AcpNewSessionResult | undefined {
  const result = record(value);
  const sessionId = str(result?.sessionId);
  if (!sessionId || sessionId.length > 200) return undefined;

  const modes = record(result?.modes);
  const availableModeIds = list(modes?.availableModes)
    .map((mode) => str(record(mode)?.id))
    .filter((id): id is string => Boolean(id));
  const currentModeId = str(modes?.currentModeId);

  return { sessionId, availableModeIds, ...(currentModeId ? { currentModeId } : {}) };
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export function readStopReason(value: unknown): AcpStopReason | undefined {
  const reason = str(record(value)?.stopReason);
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return reason;
    default:
      return undefined;
  }
}

/** ACP's tool kinds. `other` absorbs anything a newer agent invents. */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

const TOOL_KINDS: readonly AcpToolKind[] = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
];

function toolKind(value: unknown): AcpToolKind | undefined {
  return typeof value === "string" && (TOOL_KINDS as readonly string[]).includes(value)
    ? (value as AcpToolKind)
    : undefined;
}

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

function toolStatus(value: unknown): AcpToolStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : undefined;
}

/**
 * One tool call, as much of it as TabDump keeps.
 *
 * `title`, `rawInput`, `rawOutput` and `content` are read by nothing. A title
 * for an `execute` tool is routinely the command line itself, and content
 * carries diffs and terminal output — the three things the control event model
 * has nowhere to put, by design. Only the id, the kind, the status and the
 * *locations* (paths, reduced to project-relative by the normalizer) survive.
 */
export type AcpToolCall = {
  toolCallId: string;
  kind?: AcpToolKind;
  status?: AcpToolStatus;
  locations: readonly string[];
};

/** Paths per tool call. A tool that touches more than this is summarised by count elsewhere. */
export const MAX_TOOL_LOCATIONS = 50;

function readToolCall(value: unknown): AcpToolCall | undefined {
  const call = record(value);
  const toolCallId = str(call?.toolCallId);
  if (!call || !toolCallId || toolCallId.length > 200) return undefined;

  const locations = list(call.locations)
    .map((location) => str(record(location)?.path))
    .filter((path): path is string => Boolean(path) && (path as string).length <= 4096)
    .slice(0, MAX_TOOL_LOCATIONS);

  const kind = toolKind(call.kind);
  const status = toolStatus(call.status);
  return {
    toolCallId,
    locations,
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
  };
}

export type AcpSessionUpdate =
  | { type: "message_chunk"; text: string; messageId?: string }
  | { type: "thought_chunk" }
  | { type: "tool_call"; call: AcpToolCall }
  | { type: "tool_call_update"; call: AcpToolCall }
  /** The agent says its session is now in another mode. Enforced, see adapter.ts. */
  | { type: "mode_changed"; modeId: string };

/** Reads a `session/update` notification's params. `undefined` for anything TabDump ignores. */
export function readSessionUpdate(
  params: unknown
): { sessionId: string; update: AcpSessionUpdate } | undefined {
  const envelope = record(params);
  const sessionId = str(envelope?.sessionId);
  const update = record(envelope?.update);
  if (!sessionId || !update) return undefined;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = record(update.content);
      // Text only. An image or an embedded resource in a reply is not
      // something the chat renders, and is not passed on.
      if (content?.type !== "text") return undefined;
      const text = typeof content.text === "string" ? content.text : "";
      if (!text) return undefined;
      const messageId = str(update.messageId);
      return {
        sessionId,
        update: { type: "message_chunk", text, ...(messageId ? { messageId } : {}) },
      };
    }
    case "agent_thought_chunk":
      // Presence only. The reasoning itself never travels.
      return { sessionId, update: { type: "thought_chunk" } };
    case "tool_call": {
      const call = readToolCall(update);
      return call ? { sessionId, update: { type: "tool_call", call } } : undefined;
    }
    case "tool_call_update": {
      const call = readToolCall(update);
      return call ? { sessionId, update: { type: "tool_call_update", call } } : undefined;
    }
    case "current_mode_update": {
      // Read so it can be enforced: a mode switch is how an agent moves
      // itself into approving its own actions (Phase J.2).
      const modeId = str(update.currentModeId ?? update.modeId);
      return modeId && modeId.length <= 100
        ? { sessionId, update: { type: "mode_changed", modeId } }
        : undefined;
    }
    default:
      // user_message_chunk (a replay echo), plan, available_commands_update
      // and anything newer.
      return undefined;
  }
}

export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export type AcpPermissionRequest = {
  sessionId: string;
  call: AcpToolCall;
  options: readonly { optionId: string; kind: AcpPermissionOptionKind }[];
};

export function readPermissionRequest(params: unknown): AcpPermissionRequest | undefined {
  const envelope = record(params);
  const sessionId = str(envelope?.sessionId);
  const call = readToolCall(envelope?.toolCall);
  if (!sessionId || !call) return undefined;

  const options: { optionId: string; kind: AcpPermissionOptionKind }[] = [];
  for (const raw of list(envelope?.options)) {
    const option = record(raw);
    const optionId = str(option?.optionId);
    const kind = option?.kind;
    if (
      optionId &&
      (kind === "allow_once" || kind === "allow_always" || kind === "reject_once" || kind === "reject_always")
    ) {
      options.push({ optionId, kind });
    }
  }

  return { sessionId, call, options };
}

/**
 * The answer to a permission request.
 *
 * **Never `allow_always`.** An "always" answer would be the agent remembering a
 * blanket grant TabDump cannot see or revoke, so a later identical action would
 * not come back for approval. A grant is TabDump's to hold. If an agent offers
 * no one-time option, the request is answered `cancelled`, which every ACP
 * agent treats as a refusal — failing closed rather than widening.
 */
export function permissionOutcome(
  request: AcpPermissionRequest,
  decision: "granted" | "denied" | "cancelled"
): { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } } {
  const wanted: AcpPermissionOptionKind | undefined =
    decision === "granted" ? "allow_once" : decision === "denied" ? "reject_once" : undefined;
  const option = wanted ? request.options.find((candidate) => candidate.kind === wanted) : undefined;
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
