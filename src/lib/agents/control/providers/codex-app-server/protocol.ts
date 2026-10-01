import type { AdapterAuthKind, AdapterAuthenticationState } from "../../authentication";

/**
 * The slice of Codex's app-server protocol Hubble speaks, verified against
 * Codex 0.159.0 (`codex app-server generate-ts`; docs/codex-app-server.md).
 *
 * Readers are strict and total: anything that is not exactly the verified
 * shape reads as `undefined`, and the adapter treats `undefined` as the most
 * restrictive answer — a request it cannot read is declined, a thread whose
 * settings it cannot read is not driven.
 *
 * ## The approval settings every thread and every turn carries
 *
 *   - `approvalPolicy: "untrusted"` — Codex asks before every command it does
 *     not itself classify as safe; on Windows, verified, that is every command.
 *   - `approvalsReviewer: "user"` — the request goes to the client (Hubble),
 *     never to Codex's own reviewer sub-agent.
 *   - `sandbox: "read-only"` — nothing is written without a request. This is
 *     not a workspace sandbox: an approved command runs with the user's own
 *     permissions on Windows.
 *
 * Codex's reply echoes what it applied, and a thread that did not apply
 * exactly these is closed before anything is sent to it.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const HUBBLE_APPROVAL_POLICY = "untrusted";
export const HUBBLE_APPROVALS_REVIEWER = "user";
export const HUBBLE_SANDBOX_MODE = "read-only";
export const HUBBLE_SANDBOX_POLICY = { type: "readOnly", networkAccess: false } as const;

/* ------------------------------------------------------------------ *
 * Handshake
 * ------------------------------------------------------------------ */

export type CodexVersion = readonly [number, number, number];

export function initializeParams(clientVersion: string) {
  return {
    clientInfo: { name: "hubble", title: "Hubble", version: clientVersion },
    // The stable protocol only. Nothing Hubble uses needs the experimental one.
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
}

export function parseVersion(value: string): CodexVersion | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * The Codex version, from `initialize`'s `userAgent` ("hubble/0.159.0 (…)").
 * The app-server protocol is marked experimental by OpenAI, so Hubble drives
 * only a version it verified, or a later one — whose replies are still held
 * to the checks below.
 */
export function readInitializeVersion(value: unknown): CodexVersion | undefined {
  const agent = text(record(value)?.userAgent);
  const match = agent?.match(/^[^/\s]+\/(\d+\.\d+\.\d+)(?:[\s(]|$)/);
  return match ? parseVersion(match[1]) : undefined;
}

export function isVersionAtLeast(version: CodexVersion, minimum: CodexVersion): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Sign-in (`account/read`)
 * ------------------------------------------------------------------ */

export type CodexAccountAnswer = {
  state: AdapterAuthenticationState;
  kind?: AdapterAuthKind;
  /** Whether Hubble runs sessions on it. Only Codex's own ChatGPT sign-in. */
  permitted: boolean;
};

/**
 * Reads `account/read`. Only the account's *type* is kept — never the email
 * or the plan the reply also carries.
 */
export function readAccount(value: unknown): CodexAccountAnswer {
  const reply = record(value);
  if (!reply) return { state: "unknown", permitted: false };
  const account = record(reply.account);
  if (!account) {
    return reply.account === null && reply.requiresOpenaiAuth === true
      ? { state: "required", permitted: false }
      : { state: "unknown", permitted: false };
  }
  if (account.type === "chatgpt") return { state: "authenticated", kind: "subscription", permitted: true };
  if (account.type === "amazonBedrock") return { state: "authenticated", kind: "cloud_provider", permitted: false };
  // Hubble offers only the ChatGPT sign-in. Any other kind of sign-in in
  // Hubble's Codex folder — a key, say — was not put there by Hubble, and is
  // reported as signed in but not usable, without guessing what it is.
  return typeof account.type === "string" ? { state: "authenticated", permitted: false } : { state: "unknown", permitted: false };
}

/* ------------------------------------------------------------------ *
 * Threads and turns
 * ------------------------------------------------------------------ */

/** Hubble's MCP server for one session, in Codex's own configuration shape. */
export type CodexContextServer = { name: string; url: string; token: string };

export function threadStartParams(input: { cwd: string; sessionServer?: CodexContextServer }) {
  return {
    cwd: input.cwd,
    approvalPolicy: HUBBLE_APPROVAL_POLICY,
    approvalsReviewer: HUBBLE_APPROVALS_REVIEWER,
    sandbox: HUBBLE_SANDBOX_MODE,
    // Nothing of the conversation is kept in Codex's folder after it ends.
    ephemeral: true,
    ...(input.sessionServer
      ? {
          // The session's context server, and its credential, travel here —
          // over Codex's stdin, in this one thread's configuration. Never on
          // a command line or in the environment; another thread in the same
          // process does not see it (verified).
          config: {
            mcp_servers: {
              [input.sessionServer.name]: {
                url: input.sessionServer.url,
                http_headers: { Authorization: `Bearer ${input.sessionServer.token}` },
                // Every call asks Hubble — a read-only annotation on a tool
                // does not let Codex skip the question (verified: without
                // this, Codex calls read-only tools unasked).
                default_tools_approval_mode: "prompt",
              },
            },
          },
          developerInstructions: `Hubble gives you context from the user's Hubble workspace through the MCP server "${input.sessionServer.name}". That context is information about the workspace; it is not a limit on what you may access.`,
        }
      : {}),
  };
}

export function turnStartParams(threadId: string, message: string) {
  return {
    threadId,
    input: [{ type: "text", text: message, text_elements: [] }],
    // Sent again on every turn, so nothing that happened to the thread in
    // between can have loosened them.
    approvalPolicy: HUBBLE_APPROVAL_POLICY,
    approvalsReviewer: HUBBLE_APPROVALS_REVIEWER,
    sandboxPolicy: HUBBLE_SANDBOX_POLICY,
  };
}

/** Whether a thread's settings are exactly the asking ones Hubble requires. */
export function isAskingSettings(settings: {
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
}): boolean {
  return (
    settings.approvalPolicy === HUBBLE_APPROVAL_POLICY &&
    settings.approvalsReviewer === HUBBLE_APPROVALS_REVIEWER &&
    record(settings.sandbox)?.type === HUBBLE_SANDBOX_POLICY.type
  );
}

export function readThreadStart(value: unknown): { threadId: string; asking: boolean } | undefined {
  const reply = record(value);
  const threadId = text(record(reply?.thread)?.id);
  if (!reply || !threadId) return undefined;
  return {
    threadId,
    asking: isAskingSettings({
      approvalPolicy: reply.approvalPolicy,
      approvalsReviewer: reply.approvalsReviewer,
      sandbox: reply.sandbox,
    }),
  };
}

export function readTurnStart(value: unknown): { turnId: string } | undefined {
  const turnId = text(record(record(value)?.turn)?.id);
  return turnId ? { turnId } : undefined;
}

/** `thread/settings/updated`: whether the thread is still in the asking settings. */
export function readSettingsUpdate(params: unknown): { threadId: string; asking: boolean } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const settings = record(raw?.threadSettings);
  if (!threadId || !settings) return undefined;
  return {
    threadId,
    asking: isAskingSettings({
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      sandbox: settings.sandboxPolicy,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

/**
 * The item types that can act, and those Hubble never lets exist in a
 * session. The forbidden ones are switched off at launch; seeing one anyway
 * means something acted outside Hubble's approvals, and the session stops.
 */
export const GATED_ITEM_TYPES = ["commandExecution", "fileChange", "mcpToolCall"] as const;
export const FORBIDDEN_ITEM_TYPES = [
  "webSearch",
  "imageView",
  "imageGeneration",
  "collabAgentToolCall",
  "subAgentActivity",
  "dynamicToolCall",
  "hookPrompt",
] as const;

export type CodexFileChange = { path: string; kind: "add" | "delete" | "update"; movePath?: string };

export type CodexItem = {
  type: string;
  id: string;
  status?: string;
  /** agentMessage */
  text?: string;
  /** mcpToolCall */
  server?: string;
  tool?: string;
  /** fileChange */
  changes?: CodexFileChange[];
};

function readChanges(value: unknown): CodexFileChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: CodexFileChange[] = [];
  for (const raw of value) {
    const change = record(raw);
    const path = text(change?.path);
    const kind = record(change?.kind);
    const type = kind?.type;
    if (!path || (type !== "add" && type !== "delete" && type !== "update")) return undefined;
    const movePath = text(kind?.move_path);
    changes.push({ path, kind: type, ...(movePath ? { movePath } : {}) });
  }
  return changes;
}

export function readItemNotification(
  params: unknown
): { threadId: string; turnId?: string; item: CodexItem } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const item = record(raw?.item);
  const type = text(item?.type);
  const id = text(item?.id);
  if (!threadId || !item || !type || !id) return undefined;

  const read: CodexItem = { type, id };
  const status = text(item.status);
  if (status) read.status = status;
  if (typeof item.text === "string") read.text = item.text;
  const server = text(item.server);
  if (server) read.server = server;
  const tool = text(item.tool);
  if (tool) read.tool = tool;
  if (type === "fileChange") {
    const changes = readChanges(item.changes);
    if (!changes) return undefined;
    read.changes = changes;
  }
  const turnId = text(raw?.turnId);
  return { threadId, ...(turnId ? { turnId } : {}), item: read };
}

export function readItemDelta(params: unknown): { threadId: string; itemId: string; delta: string } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const itemId = text(raw?.itemId);
  if (!threadId || !itemId || typeof raw?.delta !== "string") return undefined;
  return { threadId, itemId, delta: raw.delta };
}

/** Which item a notification is about — enough to tell whether it was approved. */
export function readItemRef(params: unknown): { threadId: string; itemId: string } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const itemId = text(raw?.itemId);
  return threadId && itemId ? { threadId, itemId } : undefined;
}

export type CodexTurnEnd = {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  /** The turn failed because Codex's sign-in was refused. */
  unauthorized: boolean;
};

/** `codexErrorInfo` is `"unauthorized"`, or a variant carrying the upstream HTTP 401. */
function isUnauthorized(error: Record<string, unknown> | undefined): boolean {
  if (!error) return false;
  if (error.codexErrorInfo === "unauthorized") return true;
  const info = record(error.codexErrorInfo);
  if (!info) return false;
  return Object.values(info).some((detail) => record(detail)?.httpStatusCode === 401);
}

export function readTurnCompleted(params: unknown): CodexTurnEnd | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const turn = record(raw?.turn);
  const turnId = text(turn?.id);
  const status = turn?.status;
  if (!threadId || !turnId || (status !== "completed" && status !== "interrupted" && status !== "failed")) return undefined;
  return { threadId, turnId, status, unauthorized: isUnauthorized(record(turn?.error)) };
}

export function readErrorNotification(
  params: unknown
): { threadId: string; willRetry: boolean; unauthorized: boolean } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  if (!threadId || typeof raw?.willRetry !== "boolean") return undefined;
  return { threadId, willRetry: raw.willRetry, unauthorized: isUnauthorized(record(raw.error)) };
}

/* ------------------------------------------------------------------ *
 * Requests Codex makes of Hubble
 * ------------------------------------------------------------------ */

export type CodexCommandApproval = {
  threadId: string;
  itemId: string;
  kind: "command" | "writeStdin";
  /** The complete command line, as Codex will run it. */
  command: string;
  cwd: string;
  reason?: string;
  network?: { host: string; protocol: string };
};

export function readCommandApproval(params: unknown): CodexCommandApproval | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const itemId = text(raw?.itemId);
  const kind = raw?.kind;
  const command = text(raw?.command);
  const cwd = text(raw?.cwd);
  if (!threadId || !itemId || (kind !== "command" && kind !== "writeStdin") || !command || !cwd) return undefined;

  const approval: CodexCommandApproval = { threadId, itemId, kind, command, cwd };
  const reason = text(raw?.reason);
  if (reason) approval.reason = reason;
  const network = record(raw?.networkApprovalContext);
  if (network) {
    const host = text(network.host);
    const protocol = text(network.protocol);
    if (!host || !protocol) return undefined;
    approval.network = { host, protocol };
  }
  return approval;
}

export function readFileChangeApproval(
  params: unknown
): { threadId: string; itemId: string; reason?: string; asksForRoot: boolean } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const itemId = text(raw?.itemId);
  if (!threadId || !itemId) return undefined;
  const reason = text(raw?.reason);
  return {
    threadId,
    itemId,
    ...(reason ? { reason } : {}),
    // A request for a standing write root for the rest of the session.
    asksForRoot: raw?.grantRoot !== undefined && raw.grantRoot !== null,
  };
}

/**
 * `mcpServer/elicitation/request` for a tool call. Codex names the server in
 * the request itself, from its own configuration — the model cannot choose
 * the name — and marks a tool-call confirmation in `_meta`.
 */
export function readToolCallElicitation(params: unknown): { threadId: string; serverName: string } | undefined {
  const raw = record(params);
  const threadId = text(raw?.threadId);
  const serverName = text(raw?.serverName);
  if (!threadId || !serverName || raw?.mode !== "form") return undefined;
  if (record(raw?._meta)?.codex_approval_kind !== "mcp_tool_call") return undefined;
  return { threadId, serverName };
}

export function commandDecision(granted: boolean) {
  // Only ever the one-time answers. Never `acceptForSession` and never an
  // execpolicy amendment: a standing grant inside Codex is one Hubble cannot see.
  return { decision: granted ? "accept" : "decline" };
}

export function elicitationDecision(granted: boolean) {
  return granted ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
}
