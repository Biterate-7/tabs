import { isAgentProviderId } from "@/lib/agents/connectors/types";
import { providerDisplayName } from "@/lib/agents/platform/catalog";
import { focusFitsSnapshot } from "@/lib/agents/session-context/focus";
import type { AgentActivityEntry } from "@/lib/agents/activity/timeline";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import type { SessionFocus } from "@/lib/agents/session-context/focus";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";

/**
 * An explicit agent handoff (Hubble 1.4): the person hands the work of one
 * agent session to another agent, in the same workspace.
 *
 *     Agent A session ──▶ handoff ──▶ Agent B session
 *
 * ## A relationship, not a merge
 *
 * Both sessions stay what they were — two control sessions, two providers,
 * two journals, two histories. The handoff is the third thing that joins
 * them, by id: `sourceSessionId` and `targetSessionId`. Nothing anywhere
 * infers it from a time, a workspace name, a title or two sessions sitting
 * next to each other in a list.
 *
 * ## User-triggered, and nothing more
 *
 * A handoff exists only because the person chose "Continue with…", picked
 * the agent, saw what would be passed, and confirmed. No agent can raise one
 * (adapters are refused the handoff event kinds at the boundary), and the
 * handoff grants nothing: the new session's permissions come from its
 * project exactly as any session's do, and every write it makes still asks.
 *
 * ## What crosses, and what never does
 *
 * Only what the person selected, in three explicit modes:
 *
 *   - **Workspace context** — the new session is bound to the same workspace
 *     through the existing context server (a fresh snapshot, and the source's
 *     focus), and told how much of it there is. Counts here; the content stays
 *     behind the server, read one bounded answer at a time.
 *   - **Previous result** — what the source session *did*, as the activity
 *     timeline words it: the collections it created, the files it wrote. Never
 *     what it said, never what it thought.
 *   - **User instruction** — the person's own words, bounded.
 *
 * Never a credential, a header, a token, a transcript, a tool payload, a
 * command line or a reasoning trace: there is no field for any of them, and
 * the instruction — the one free text — is scrubbed of anything shaped like
 * a secret before it is kept or sent.
 *
 * Pure: imported by the runtime host, the browser and the landing page's
 * deterministic demo alike, so the preview the person reads, the envelope the
 * target agent receives and the record history keeps are built by the same
 * functions everywhere.
 */

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/**
 * Where a handoff stands. `preparing` is the preview the person is reading;
 * `creating_session` and `sending_context` are the runtime's two steps;
 * `ready`, `failed` and `cancelled` are final.
 */
export type HandoffStatus = "preparing" | "creating_session" | "sending_context" | "ready" | "failed" | "cancelled";

export const HANDOFF_STATUSES: readonly HandoffStatus[] = [
  "preparing",
  "creating_session",
  "sending_context",
  "ready",
  "failed",
  "cancelled",
] as const;

/** Statuses after which a handoff never changes. Only `ready` and `failed` are kept by history. */
export const FINAL_HANDOFF_STATUSES: readonly HandoffStatus[] = ["ready", "failed", "cancelled"] as const;

export function isFinalHandoffStatus(status: HandoffStatus): boolean {
  return (FINAL_HANDOFF_STATUSES as readonly string[]).includes(status);
}

/** Where a failed handoff stopped. The source session is untouched either way. */
export type HandoffFailure =
  /** The target agent's session could not be started. Nothing exists on the other side. */
  | "session_not_created"
  /** The session started, but the handoff never reached the agent. It was not told anything. */
  | "context_not_delivered";

/** The modes the person chose. The instruction is its own field. */
export type HandoffInclude = { workspace: boolean; previousResult: boolean };

/** How much of the workspace the target was given — counts, never content. */
export type HandoffWorkspaceContext = {
  tabs: number;
  collections: number;
  /** The tabs and collections the source session was pointed at, carried over by reference. */
  focus?: { tabs: number; collections: number };
};

/** One thing the source session did, in the activity timeline's own words. */
export type HandoffResultLine = { title: string; description?: string };

/** What the source session did, as the person and the target agent read it. */
export type HandoffPreviousResult = {
  /** How the source session stood when the work was handed over. */
  outcome: "finished" | "stopped" | "failed" | "waiting" | "idle";
  lines: readonly HandoffResultLine[];
  /** Results beyond the bound, said as a count rather than dropped silently. */
  more: number;
};

/**
 * A handoff, as the runtime records it and every surface reads it.
 *
 * Ids, providers, counts, the timeline's own result lines, and the person's
 * instruction. The workspace is named by id: its name is looked up live, as
 * for every other record.
 */
export type SessionHandoff = {
  handoffId: string;
  workspaceId: string;
  sourceSessionId: string;
  sourceProvider: AgentProviderId;
  targetProvider: AgentProviderId;
  /** Set once the target session exists — on `ready`, and on a `context_not_delivered` failure. */
  targetSessionId?: string;
  status: HandoffStatus;
  failure?: HandoffFailure;
  /** What was (or, while preparing, would be) passed. A mode the person left out is absent. */
  context: {
    workspace?: HandoffWorkspaceContext;
    previousResult?: HandoffPreviousResult;
  };
  instruction?: string;
  createdAt: number;
  updatedAt: number;
};

/** One end of a handoff as a session row shows it: "→ Codex", "← Claude Code". */
export type HandoffLink = {
  handoffId: string;
  /** The session on the other end, when there is one. */
  sessionId?: string;
  provider: AgentProviderId;
  status: HandoffStatus;
};

/** A session's handoffs, both ways. A session was handed at most one piece of work; it may hand on several. */
export type SessionHandoffLinks = { from?: HandoffLink; to?: readonly HandoffLink[] };

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export const HANDOFF_LIMITS = {
  /** The person's instruction. A paragraph, not a document. */
  instruction: 2_000,
  /** Result lines passed on; beyond it the rest is a count. */
  resultLines: 12,
  /** One result line's text. */
  lineText: 300,
  id: 200,
} as const;

/* ------------------------------------------------------------------ *
 * The source: which sessions can hand work on
 * ------------------------------------------------------------------ */

/**
 * Statuses a session can be handed on from. Something the person reviewed:
 * a finished turn (`ready`), a question it left (`waiting_for_input`), or a
 * session that ended. Never mid-turn or mid-approval — the work is still
 * moving, and a decision is still owed.
 */
const HANDOFF_SOURCE_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  "ready",
  "waiting_for_input",
  "completed",
  "cancelled",
  "failed",
  "disconnected",
]);

export function canHandOffFrom(status: AgentSessionStatus): boolean {
  return HANDOFF_SOURCE_STATUSES.has(status);
}

/* ------------------------------------------------------------------ *
 * Previous result
 * ------------------------------------------------------------------ */

/** Timeline entries that are results — something the session made or changed — not reads, talk or lifecycle. */
const RESULT_KINDS: ReadonlySet<AgentActivityEntry["kind"]> = new Set(["created", "updated", "workspace_updated", "command"]);

function outcomeOf(status: AgentSessionStatus): HandoffPreviousResult["outcome"] {
  switch (status) {
    case "completed":
    case "ready":
      return "finished";
    case "cancelled":
      return "stopped";
    case "failed":
    case "disconnected":
      return "failed";
    case "waiting_for_input":
    case "waiting_for_approval":
      return "waiting";
    default:
      return "idle";
  }
}

const line = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, HANDOFF_LIMITS.lineText);

/**
 * What the source session did, from its own activity timeline — the same
 * entries, in the same words, the person already reads in Activity. A change
 * the person undid is not a result any more and is left out; nothing the
 * agent said is in a result entry to begin with.
 */
export function summarizePreviousResult(
  entries: readonly AgentActivityEntry[],
  status: AgentSessionStatus
): HandoffPreviousResult {
  const undone = new Set(entries.filter((entry) => entry.kind === "undone").map((entry) => entry.refs?.changeId).filter(Boolean));
  const results = entries.filter(
    (entry) =>
      RESULT_KINDS.has(entry.kind) &&
      entry.status === "completed" &&
      !(entry.refs?.changeId && undone.has(entry.refs.changeId))
  );
  const kept = results.slice(0, HANDOFF_LIMITS.resultLines).map((entry) => ({
    title: line(entry.title),
    ...(entry.description ? { description: line(entry.description) } : {}),
  }));
  return { outcome: outcomeOf(status), lines: kept, more: Math.max(0, results.length - kept.length) };
}

/* ------------------------------------------------------------------ *
 * Workspace context
 * ------------------------------------------------------------------ */

/** How much of the workspace a snapshot holds, and how much of it the focus names. */
export function workspaceContextOf(snapshot: SessionContextSnapshot, focus: SessionFocus | undefined): HandoffWorkspaceContext {
  const fits = focus && focusFitsSnapshot(snapshot, focus) ? focus : undefined;
  return {
    tabs: snapshot.workspace.tabs.length,
    collections: snapshot.collections.length,
    ...(fits && (fits.tabIds.length > 0 || fits.collectionIds.length > 0)
      ? { focus: { tabs: fits.tabIds.length, collections: fits.collectionIds.length } }
      : {}),
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What a handoff passed, in a few words: "Workspace context · Previous
 * result · Your instruction". The modes only — what each held is the
 * inspector's to show.
 */
export function handoffPassedLine(handoff: Pick<SessionHandoff, "context" | "instruction">): string {
  const parts = [
    handoff.context.workspace ? "Workspace context" : undefined,
    handoff.context.previousResult ? "Previous result" : undefined,
    handoff.instruction ? "Your instruction" : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No context passed";
}

/** "18 tabs · 3 collections" — the context counts as every surface writes them. */
export function workspaceContextLine(context: HandoffWorkspaceContext): string {
  return `${plural(context.tabs, "tab", "tabs")} · ${plural(context.collections, "collection", "collections")}`;
}

/** "3 tabs · 1 collection" of focus, or `undefined` when there is none. */
export function focusLine(context: HandoffWorkspaceContext): string | undefined {
  const focus = context.focus;
  if (!focus) return undefined;
  const parts = [
    focus.tabs > 0 ? plural(focus.tabs, "tab", "tabs") : undefined,
    focus.collections > 0 ? plural(focus.collections, "collection", "collections") : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/* ------------------------------------------------------------------ *
 * The person's instruction
 * ------------------------------------------------------------------ */

/**
 * Shapes that are credentials far more often than they are anything else.
 * The instruction is the one free text a handoff carries, so it is scrubbed
 * before it is kept or sent: a key pasted by mistake goes nowhere.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys (sk-…, sk-ant-…)
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization header values
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*\S{6,}/gi, // key=value pairs
];

export const REDACTED = "[redacted]";

/** Whether text holds something shaped like a credential. */
export function containsSecretShape(value: string): boolean {
  return SECRET_SHAPES.some((pattern) => {
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    return found;
  });
}

/**
 * The instruction as it may be kept and sent: control characters gone (line
 * breaks kept — it is prose), blank lines collapsed, anything shaped like a
 * secret replaced, bounded. `undefined` when nothing is left.
 */
export function readHandoffInstruction(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  for (const pattern of SECRET_SHAPES) text = text.replace(pattern, REDACTED);
  if (!text) return undefined;
  return text.length > HANDOFF_LIMITS.instruction ? text.slice(0, HANDOFF_LIMITS.instruction).trimEnd() : text;
}

/* ------------------------------------------------------------------ *
 * The envelope the target agent receives
 * ------------------------------------------------------------------ */

export function agentDisplayName(provider: AgentProviderId): string {
  return providerDisplayName(provider);
}

export type HandoffEnvelopeInput = {
  workspaceName: string;
  sourceProvider: AgentProviderId;
  /** The source session's title, when it has one. */
  sourceTitle?: string;
  context: SessionHandoff["context"];
  /** Whether the target was handed Hubble's workspace tools (the context server). */
  contextTools: boolean;
  instruction?: string;
};

const RESULT_OUTCOME_WORDS: Record<HandoffPreviousResult["outcome"], string> = {
  finished: "Finished",
  stopped: "Stopped before finishing",
  failed: "Stopped on an error",
  waiting: "Waiting on the person",
  idle: "Not started",
};

/**
 * The first message the target agent receives: a short, structured note
 * that it is continuing someone else's work, and what it was given.
 *
 * Built only from the record's fields — names, counts, the timeline's result
 * lines, the person's scrubbed instruction — so it can carry nothing the
 * record could not: no transcript, no reasoning, no credential.
 */
export function buildHandoffEnvelope(input: HandoffEnvelopeInput): string {
  const lines: string[] = ["HUBBLE HANDOFF", ""];
  lines.push(
    "The person you are working with has handed you work another agent did in their Hubble workspace. Continue from it."
  );
  lines.push("");
  lines.push(`Workspace: ${line(input.workspaceName) || "Untitled workspace"}`);
  lines.push(`Previous agent: ${agentDisplayName(input.sourceProvider)}`);
  if (input.sourceTitle) lines.push(`Previous session: ${line(input.sourceTitle)}`);

  const result = input.context.previousResult;
  if (result) {
    lines.push("");
    lines.push(`Previous result: ${RESULT_OUTCOME_WORDS[result.outcome]}`);
    if (result.lines.length === 0) lines.push("- No workspace or file changes were recorded.");
    for (const entry of result.lines) lines.push(`- ${entry.title}${entry.description ? ` (${entry.description})` : ""}`);
    if (result.more > 0) lines.push(`- …and ${plural(result.more, "more result", "more results")}`);
  }

  const workspace = input.context.workspace;
  lines.push("");
  if (workspace && input.contextTools) {
    lines.push(`Workspace context: ${workspaceContextLine(workspace)}`);
    const focus = focusLine(workspace);
    if (focus) lines.push(`Selected: ${focus}`);
    lines.push("Read it through Hubble's workspace tools. Changes to the workspace ask the person first.");
  } else if (workspace) {
    lines.push("Workspace context: not available to you in this session.");
  } else {
    lines.push("Workspace context: not shared for this handoff.");
  }

  if (input.instruction) {
    lines.push("");
    lines.push("Instruction from the person:");
    lines.push(input.instruction);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Preview → confirmation
 * ------------------------------------------------------------------ */

/** What a fingerprint looks like on the wire: 16 lowercase hex characters. */
export const HANDOFF_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

/** A key-sorted serialization, so the same value always fingerprints the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a, twice with different seeds, as 16 hex characters. A binding, not a secret. */
function fnv(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Binds a confirmation to the preview the person read: the source, the
 * agent, the workspace and everything that could be passed. Confirming
 * re-derives the context, and a different fingerprint means the person would
 * be sending something they did not see.
 */
export function handoffFingerprint(input: {
  sourceSessionId: string;
  targetProvider: AgentProviderId;
  workspaceId: string;
  context: SessionHandoff["context"];
  contextTools: boolean;
}): string {
  const text = stable(input);
  return fnv(text, 0x811c9dc5) + fnv(text, 0x01234567);
}

/** The modes the person kept, out of everything the preview offered. */
export function selectHandoffContext(context: SessionHandoff["context"], include: HandoffInclude): SessionHandoff["context"] {
  return {
    ...(include.workspace && context.workspace ? { workspace: context.workspace } : {}),
    ...(include.previousResult && context.previousResult ? { previousResult: context.previousResult } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Reading (untrusted: the wire, the database)
 * ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= HANDOFF_LIMITS.id;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
const isStatus = (value: unknown): value is HandoffStatus => typeof value === "string" && (HANDOFF_STATUSES as readonly string[]).includes(value);
const OUTCOMES = new Set(["finished", "stopped", "failed", "waiting", "idle"]);

function readWorkspaceContext(raw: unknown): HandoffWorkspaceContext | null {
  if (!isRecord(raw) || !isCount(raw.tabs) || !isCount(raw.collections)) return null;
  if (raw.focus !== undefined) {
    const focus = raw.focus;
    if (!isRecord(focus) || !isCount(focus.tabs) || !isCount(focus.collections)) return null;
    return { tabs: raw.tabs, collections: raw.collections, focus: { tabs: focus.tabs, collections: focus.collections } };
  }
  return { tabs: raw.tabs, collections: raw.collections };
}

function readPreviousResult(raw: unknown): HandoffPreviousResult | null {
  if (!isRecord(raw) || !OUTCOMES.has(raw.outcome as string) || !isCount(raw.more)) return null;
  if (!Array.isArray(raw.lines) || raw.lines.length > HANDOFF_LIMITS.resultLines) return null;
  const lines: HandoffResultLine[] = [];
  for (const entry of raw.lines) {
    if (!isRecord(entry) || typeof entry.title !== "string" || !entry.title || entry.title.length > HANDOFF_LIMITS.lineText) return null;
    if (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > HANDOFF_LIMITS.lineText)) return null;
    lines.push({ title: entry.title, ...(entry.description ? { description: entry.description as string } : {}) });
  }
  return { outcome: raw.outcome as HandoffPreviousResult["outcome"], lines, more: raw.more };
}

/** A handoff as it arrives from the wire or the database, revalidated field by field. `null`: unreadable. */
export function readSessionHandoff(raw: unknown): SessionHandoff | null {
  if (!isRecord(raw)) return null;
  if (!isId(raw.handoffId) || !isId(raw.workspaceId) || !isId(raw.sourceSessionId)) return null;
  if (!isAgentProviderId(raw.sourceProvider) || !isAgentProviderId(raw.targetProvider)) return null;
  if (raw.targetSessionId !== undefined && !isId(raw.targetSessionId)) return null;
  if (!isStatus(raw.status) || !isTime(raw.createdAt) || !isTime(raw.updatedAt)) return null;
  if (raw.failure !== undefined && raw.failure !== "session_not_created" && raw.failure !== "context_not_delivered") return null;
  if (raw.status === "failed" && raw.failure === undefined) return null;
  if (!isRecord(raw.context)) return null;
  const workspace = raw.context.workspace === undefined ? undefined : readWorkspaceContext(raw.context.workspace);
  const previousResult = raw.context.previousResult === undefined ? undefined : readPreviousResult(raw.context.previousResult);
  if (workspace === null || previousResult === null) return null;
  let instruction: string | undefined;
  if (raw.instruction !== undefined) {
    // Kept only as it was scrubbed: one that does not survive re-reading is not shown.
    instruction = readHandoffInstruction(raw.instruction);
    if (instruction !== raw.instruction) return null;
  }
  return {
    handoffId: raw.handoffId,
    workspaceId: raw.workspaceId,
    sourceSessionId: raw.sourceSessionId,
    sourceProvider: raw.sourceProvider,
    targetProvider: raw.targetProvider,
    ...(raw.targetSessionId ? { targetSessionId: raw.targetSessionId as string } : {}),
    status: raw.status,
    ...(raw.failure ? { failure: raw.failure as HandoffFailure } : {}),
    context: {
      ...(workspace ? { workspace } : {}),
      ...(previousResult ? { previousResult } : {}),
    },
    ...(instruction ? { instruction } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Relationships
 * ------------------------------------------------------------------ */

/** A session's handoffs, both ways, from explicit records. Only handoffs that happened: never one being prepared or cancelled. */
export function handoffLinksOf(sessionId: string, handoffs: readonly SessionHandoff[]): SessionHandoffLinks | undefined {
  let from: HandoffLink | undefined;
  const to: HandoffLink[] = [];
  for (const handoff of handoffs) {
    if (handoff.status !== "ready" && handoff.status !== "failed") continue;
    if (handoff.targetSessionId === sessionId && handoff.status === "ready") {
      from = { handoffId: handoff.handoffId, sessionId: handoff.sourceSessionId, provider: handoff.sourceProvider, status: handoff.status };
    }
    if (handoff.sourceSessionId === sessionId) {
      to.push({
        handoffId: handoff.handoffId,
        ...(handoff.targetSessionId ? { sessionId: handoff.targetSessionId } : {}),
        provider: handoff.targetProvider,
        status: handoff.status,
      });
    }
  }
  if (!from && to.length === 0) return undefined;
  return { ...(from ? { from } : {}), ...(to.length > 0 ? { to } : {}) };
}

/** Reads links from the wire. Unreadable links are dropped, never repaired. */
export function readHandoffLinks(raw: unknown): SessionHandoffLinks | undefined {
  if (!isRecord(raw)) return undefined;
  const link = (value: unknown): HandoffLink | null => {
    if (!isRecord(value) || !isId(value.handoffId) || !isAgentProviderId(value.provider) || !isStatus(value.status)) return null;
    if (value.sessionId !== undefined && !isId(value.sessionId)) return null;
    return { handoffId: value.handoffId, provider: value.provider, status: value.status, ...(value.sessionId ? { sessionId: value.sessionId as string } : {}) };
  };
  const from = raw.from === undefined ? null : link(raw.from);
  const to = Array.isArray(raw.to) ? raw.to.slice(0, 50).map(link).filter((entry): entry is HandoffLink => entry !== null) : [];
  if (!from && to.length === 0) return undefined;
  return { ...(from ? { from } : {}), ...(to.length > 0 ? { to } : {}) };
}
