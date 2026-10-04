import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The normalized control event.
 *
 * ## Why a second event type exists
 *
 * The domain already has `AgentEvent`: five kinds, a 200-character summary,
 * capped at 200 per run, persisted. That is a *durable activity log* — what a
 * user reads weeks later in History, and it is deliberately lossy.
 *
 * This is the live wire: what a provider is saying right now, at the
 * granularity it says it. It is richer, it is not persisted in full, and it
 * is the thing a streaming UI consumes. The two are joined in exactly one
 * direction — `toDomainEventInput` below reduces a control event to the
 * domain's shape — and never the other way.
 *
 * Keeping them separate is what stops the durable log from inheriting the
 * live stream's volume and its provider-shaped detail. Merging them would put
 * a tool-call-per-second stream into localStorage.
 *
 * ## What may never appear here
 *
 * No file contents. No diff bodies. No command strings. No prompt text. No
 * model reasoning. The fields below are identity and already-safe labels, and
 * the guard test asserts that this file declares no field that could carry a
 * command or a payload. A provider adapter reduces to this shape on its own
 * side of the boundary, exactly as observation adapters already do.
 */
export type AgentControlEventKind =
  | "session_started"
  | "session_resumed"
  | "message_sent"
  | "message_received"
  /** Part of an agent message that is still being written. See `ControlMessageText`. */
  | "message_delta"
  | "thinking"
  | "tool_started"
  | "tool_finished"
  | "file_read"
  | "file_created"
  | "file_modified"
  | "command_started"
  | "command_finished"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "waiting_for_input"
  | "error"
  | "run_completed"
  | "run_cancelled"
  /**
   * Hubble bound the session to its workspace and handed the agent its
   * context server. Raised by Hubble, never by an adapter. See `ControlContextInfo`.
   */
  | "context_loaded"
  /**
   * The agent read its workspace through Hubble's context server, and the
   * server answered. Raised by Hubble, never by an adapter.
   */
  | "context_read"
  /**
   * The person handed this session's work to another agent (Hubble 1.4) — or
   * tried to. Raised by Hubble, on the source session. See `ControlHandoffInfo`.
   */
  | "handoff_sent"
  /** This session was started by a handoff, and received it. Raised by Hubble, on the target session. */
  | "handoff_received";

export const AGENT_CONTROL_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "session_started",
  "session_resumed",
  "message_sent",
  "message_received",
  "message_delta",
  "thinking",
  "tool_started",
  "tool_finished",
  "file_read",
  "file_created",
  "file_modified",
  "command_started",
  "command_finished",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "waiting_for_input",
  "error",
  "run_completed",
  "run_cancelled",
  "context_loaded",
  "context_read",
  "handoff_sent",
  "handoff_received",
] as const;

export function isAgentControlEventKind(value: unknown): value is AgentControlEventKind {
  return (
    typeof value === "string" && (AGENT_CONTROL_EVENT_KINDS as readonly string[]).includes(value)
  );
}

/** Kinds that describe a file operation and therefore carry `file`. */
export const FILE_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "file_read",
  "file_created",
  "file_modified",
] as const;

/** Kinds that describe a tool or command invocation and therefore carry `tool`. */
export const TOOL_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "tool_started",
  "tool_finished",
  "command_started",
  "command_finished",
] as const;

/** Kinds that concern an approval and therefore carry `approvalId`. */
export const APPROVAL_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "approval_requested",
  "approval_granted",
  "approval_denied",
] as const;

/**
 * Kinds Hubble raises about its own context server, which therefore carry
 * `context`. No adapter may emit one: the service drops them at the boundary,
 * so an agent cannot claim to have read a workspace it never asked about.
 */
export const CONTEXT_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "context_loaded",
  "context_read",
] as const;

export function isContextEventKind(kind: AgentControlEventKind): boolean {
  return (CONTEXT_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Kinds Hubble raises about a handoff, which therefore carry `handoff`. No
 * adapter may emit one — an agent cannot claim it was handed work, or hand
 * work on: handoffs are the person's, and only the runtime records them.
 */
export const HANDOFF_EVENT_KINDS: readonly AgentControlEventKind[] = ["handoff_sent", "handoff_received"] as const;

export function isHandoffEventKind(kind: AgentControlEventKind): boolean {
  return (HANDOFF_EVENT_KINDS as readonly string[]).includes(kind);
}

/** Kinds after which no further event for that run is expected. */
export const TERMINAL_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "run_completed",
  "run_cancelled",
  "error",
] as const;

/**
 * A tool the agent invoked.
 *
 * `name` is the tool's identifier ("Read", "Bash"), which is an enum-like
 * value from the provider and safe to show. There is deliberately **no
 * `command`, `args`, `input` or `output` field**: a shell invocation is the
 * single most dangerous string a provider could get onto a screen or into a
 * log, and the only way to be certain it cannot is to have nowhere to put it.
 *
 * `description` is the provider's own short human label for what the tool is
 * doing, when it supplies one — already prose, never an invocation. It is
 * length-capped on the way in. The existing Claude Code parser already makes
 * exactly this distinction and is the precedent.
 */
export type ControlToolInfo = {
  name: string;
  description?: string;
  /** Provider-stable id, so a `tool_finished` can be paired with its `tool_started`. */
  callId?: string;
  /** Whether the tool succeeded. Absent on `tool_started`. */
  ok?: boolean;
};

/**
 * A file the agent touched.
 *
 * Project-relative, forward-slashed, and never escaping the project root —
 * the same contract `WorkArtifact` already holds, reusing
 * `lib/agents/paths.ts` at the adapter boundary rather than re-deriving it.
 * An absolute path here would leak the user's directory layout into the event
 * stream, and the guard test checks that no adapter can emit one.
 */
export type ControlFileInfo = {
  relativePath: string;
  /** The project this path is relative to, by Hubble's project id — never a path. */
  projectId: string;
};

/**
 * What Hubble's context server did for the agent, as counts.
 *
 * ## Why this is Hubble's to say, not the adapter's
 *
 * An adapter sees a tool call go out and — for some providers — never sees it
 * come back, and it never sees what was in the answer. The session's context
 * server is the one place that knows, for every provider alike, that a search
 * found fourteen tabs. So the server measures its own answer and Hubble raises
 * the event; the numbers are the answer's, not a guess.
 *
 * ## What may never appear here
 *
 * Counts and Hubble's own identifiers only. No titles, no URLs, no tab ids, no
 * query text: an activity record is read by people who did not ask the
 * question, and "searched for <the user's words>" is not theirs to see.
 */
export type ControlContextInfo = {
  /** The workspace the session is bound to, by Hubble's id. */
  workspaceId: string;
  /**
   * On `context_read`, which of the context server's read tools answered
   * (`search_tabs`, `get_workspace_summary`, …) — Hubble's vocabulary, never a
   * provider's.
   */
  operation?: string;
  /** On `context_read`: whether the server answered rather than refused. */
  ok?: boolean;
  /** Tabs the answer covered — or, on `context_loaded`, the workspace held. */
  tabs?: number;
  collections?: number;
  /** Tabs a search or a relatedness query matched. */
  matches?: number;
  /** Topic or duplicate groups found. */
  groups?: number;
};

/**
 * A handoff, as the event on either session's stream names it (Hubble 1.4).
 *
 * Ids and closed values only. What was handed over — the context counts, the
 * previous result, the person's instruction — is the handoff record's
 * (lib/agents/handoff/handoff.ts), joined by `handoffId`; the stream says
 * only that it happened, and with whom.
 *
 * Also carried by the one `message_sent` that delivered the handoff to the
 * target agent, so that message is known for what it is by reference rather
 * than guessed from where it sits.
 */
export type ControlHandoffInfo = {
  handoffId: string;
  /** The workspace both sessions work in. A handoff never crosses workspaces. */
  workspaceId: string;
  /** The agent on the other end. */
  peerProvider: AgentProviderId;
  /** The session on the other end, when one exists. */
  peerSessionId?: string;
  /** On `handoff_sent`: whether the target received it. */
  outcome?: "ready" | "failed";
  /** On a failed `handoff_sent`: where it stopped. */
  failure?: "session_not_created" | "context_not_delivered";
};

function isWellFormedHandoffInfo(info: ControlHandoffInfo): boolean {
  if (typeof info !== "object" || info === null) return false;
  for (const key of ["handoffId", "workspaceId"] as const) {
    const value = info[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  }
  if (typeof info.peerProvider !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(info.peerProvider)) return false;
  if (info.peerSessionId !== undefined && (typeof info.peerSessionId !== "string" || !info.peerSessionId || info.peerSessionId.length > 200)) {
    return false;
  }
  if (info.outcome !== undefined && info.outcome !== "ready" && info.outcome !== "failed") return false;
  if (info.failure !== undefined && info.failure !== "session_not_created" && info.failure !== "context_not_delivered") return false;
  if ((info.outcome === "failed") !== (info.failure !== undefined)) return false;
  return true;
}

/** The count fields of `ControlContextInfo`, so validation and consumers list them once. */
export const CONTROL_CONTEXT_COUNTS = ["tabs", "collections", "matches", "groups"] as const;

/** Far above any real workspace, far below anything that would look like a payload. */
export const MAX_CONTROL_CONTEXT_COUNT = 1_000_000;

const countOf = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/**
 * A context event's summary: its counts in words ("18 tabs · 3 collections",
 * "14 matching tabs"), authored here from numbers and fixed words only, so
 * nothing a provider or a page said can reach it.
 */
export function contextCountsLine(info: ControlContextInfo): string {
  const parts: string[] = [];
  if (info.matches !== undefined) parts.push(countOf(info.matches, "matching tab", "matching tabs"));
  if (info.groups !== undefined) parts.push(countOf(info.groups, "group", "groups"));
  if (info.tabs !== undefined) parts.push(countOf(info.tabs, "tab", "tabs"));
  if (info.collections !== undefined) parts.push(countOf(info.collections, "collection", "collections"));
  if (info.ok === false) return "Hubble could not answer";
  return parts.length > 0 ? parts.join(" · ") : "Answered";
}

function isWellFormedContextInfo(info: ControlContextInfo): boolean {
  if (typeof info !== "object" || info === null) return false;
  if (typeof info.workspaceId !== "string" || info.workspaceId.length === 0 || info.workspaceId.length > 128) {
    return false;
  }
  if (info.operation !== undefined && !(typeof info.operation === "string" && /^[a-z_]{1,48}$/.test(info.operation))) {
    return false;
  }
  if (info.ok !== undefined && typeof info.ok !== "boolean") return false;
  for (const key of CONTROL_CONTEXT_COUNTS) {
    const value = info[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > MAX_CONTROL_CONTEXT_COUNT) return false;
  }
  return true;
}

/**
 * Kinds that may carry conversation text. Nothing else may.
 *
 * ## Why a message may carry its whole text now
 *
 * Until Phase J an agent's reply reached the screen as its 200-character
 * `summary`, which made the command centre a place that *reported* a
 * conversation rather than one where you could have it. The agent chat needs
 * the reply itself — it is the thing the user asked for.
 *
 * What the rule above protects is unchanged: a tool invocation, a command
 * line, a file body, a diff and model reasoning still have nowhere to go. The
 * text channel exists on exactly three kinds, all of them prose addressed to
 * a person — what the user typed, what the agent answered, and a piece of an
 * answer still being written. `isWellFormedControlEvent` rejects `text` on
 * any other kind, so a tool result cannot ride in on a `tool_finished`.
 *
 * It is live-wire only. `toDomainEventInput` never copies it, so the durable
 * activity log still holds a bounded summary and nothing more; the full
 * conversation lives in the runtime's in-memory journal for as long as the
 * session does, and is never written to browser storage.
 */
export const TEXT_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "message_sent",
  "message_received",
  "message_delta",
] as const;

/** Cap on a whole message. Long for prose, far short of a dumped file. */
export const MAX_CONTROL_MESSAGE_TEXT_LENGTH = 32_000;

/** Cap on one streamed piece. An adapter coalesces pieces before emitting. */
export const MAX_CONTROL_DELTA_TEXT_LENGTH = 4_000;

/** Bounds message text without reshaping it — line breaks are part of an answer. */
export function boundMessageText(value: string, max = MAX_CONTROL_MESSAGE_TEXT_LENGTH): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * One normalized event.
 *
 * `summary` is the one free-text field and it is bounded, already-safe, and
 * authored by the adapter rather than copied from the provider verbatim.
 */
export type AgentControlEvent = {
  id: string;
  sessionId: string;
  provider: AgentProviderId;
  kind: AgentControlEventKind;
  timestamp: number;
  /** Short, safe, human-readable. Never a command, a prompt or a tool result. */
  summary: string;
  /** The domain run this event belongs to, once the session has one. */
  runId?: string;
  tool?: ControlToolInfo;
  file?: ControlFileInfo;
  /** The approval this event concerns. See ./approvals.ts. */
  approvalId?: string;
  /** What Hubble's context server did, on the `CONTEXT_EVENT_KINDS` only. */
  context?: ControlContextInfo;
  /** The handoff this event is about, on the `HANDOFF_EVENT_KINDS` (and the `message_sent` that delivered one). */
  handoff?: ControlHandoffInfo;
  /**
   * The message itself, on the three `TEXT_EVENT_KINDS` only.
   *
   * On `message_delta` it is one piece; on `message_received` it is the whole
   * reply, which supersedes every delta sharing its `messageId`.
   */
  text?: string;
  /** Joins a reply's deltas to each other and to the final `message_received`. */
  messageId?: string;
  /**
   * Provider-stable id of the source record.
   *
   * Used only to avoid emitting the same observation twice across a
   * reconnect. Never parsed — the same rule `AgentEvent.sourceId` follows.
   */
  sourceId?: string;
};

/** Cap on a summary, matching the domain's `MAX_SUMMARY_LENGTH` so a reduction never truncates twice. */
export const MAX_CONTROL_SUMMARY_LENGTH = 200;

/** Cap on a tool name. Generous for a real identifier, far short of a payload. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Bounds and cleans a summary.
 *
 * Collapses whitespace first, because a provider that emits a multi-line blob
 * would otherwise pass the length check with 200 characters of newlines and
 * render as a broken block.
 */
export function normalizeControlSummary(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_CONTROL_SUMMARY_LENGTH
    ? collapsed.slice(0, MAX_CONTROL_SUMMARY_LENGTH)
    : collapsed;
}

/**
 * Whether an event's optional slices are consistent with its kind.
 *
 * Not a type-level constraint, because the kinds that carry a slice are a
 * runtime list an adapter could get wrong — and a `file_modified` with no
 * file is a bug that would otherwise render as a blank row rather than
 * failing. Used by the service to reject a malformed event at the boundary
 * rather than storing it.
 */
export function isWellFormedControlEvent(event: AgentControlEvent): boolean {
  if (!isAgentControlEventKind(event.kind)) return false;
  if (!event.id || !event.sessionId) return false;
  if (!Number.isFinite(event.timestamp)) return false;
  if (event.summary.length > MAX_CONTROL_SUMMARY_LENGTH) return false;

  if ((FILE_EVENT_KINDS as readonly string[]).includes(event.kind) && !event.file) return false;
  if ((TOOL_EVENT_KINDS as readonly string[]).includes(event.kind) && !event.tool) return false;
  if ((APPROVAL_EVENT_KINDS as readonly string[]).includes(event.kind) && !event.approvalId) {
    return false;
  }

  // A relative path that escapes its project is the one malformed value worth
  // rejecting structurally rather than trusting an adapter to have normalized.
  if (event.file) {
    const segments = event.file.relativePath.split("/");
    if (segments.includes("..") || event.file.relativePath.startsWith("/")) return false;
    if (/^[A-Za-z]:/.test(event.file.relativePath)) return false;
  }

  if (event.tool && event.tool.name.length > MAX_TOOL_NAME_LENGTH) return false;

  // Context counts belong to Hubble's own context kinds, and those kinds
  // always carry them: a `context_read` with nothing read is not a read.
  const contextKind = isContextEventKind(event.kind);
  if (contextKind !== (event.context !== undefined)) return false;
  if (event.context && !isWellFormedContextInfo(event.context)) return false;

  // A handoff event always says which handoff; nothing else may carry one but
  // the message that delivered it.
  const handoffKind = isHandoffEventKind(event.kind);
  if (handoffKind && event.handoff === undefined) return false;
  if (event.handoff !== undefined) {
    if (!handoffKind && event.kind !== "message_sent") return false;
    if (!isWellFormedHandoffInfo(event.handoff)) return false;
    if (event.kind === "handoff_sent" && event.handoff.outcome === undefined) return false;
  }

  if (event.text !== undefined) {
    // Text belongs to prose kinds only. A tool result is never a message.
    if (!(TEXT_EVENT_KINDS as readonly string[]).includes(event.kind)) return false;
    if (typeof event.text !== "string") return false;
    const max =
      event.kind === "message_delta" ? MAX_CONTROL_DELTA_TEXT_LENGTH : MAX_CONTROL_MESSAGE_TEXT_LENGTH;
    if (event.text.length > max) return false;
  }
  // A delta with nothing in it, or belonging to no message, is not a delta.
  if (event.kind === "message_delta" && (!event.text || !event.messageId)) return false;

  return true;
}

/**
 * Which domain event kind a control event reduces to, or `null` for one that
 * has no durable equivalent.
 *
 * Most of the live stream is deliberately *not* persisted. `thinking` fires
 * constantly and says nothing a week later; `message_sent` is the user's own
 * action. What survives is what a person would want to read in History:
 * lifecycle, file work, and failures.
 */
export function domainEventKindFor(
  kind: AgentControlEventKind
): "started" | "status" | "activity" | "link" | "ended" | null {
  switch (kind) {
    case "session_started":
    case "session_resumed":
      return "started";
    case "run_completed":
    case "run_cancelled":
      return "ended";
    case "error":
    case "waiting_for_input":
    case "approval_requested":
    case "approval_granted":
    case "approval_denied":
      return "status";
    case "file_read":
    case "file_created":
    case "file_modified":
      return "link";
    case "tool_started":
    case "tool_finished":
    case "command_started":
    case "command_finished":
    case "message_received":
      return "activity";
    case "thinking":
    case "message_sent":
    case "message_delta":
    // Context reads fire per tool call and the workspace itself is the
    // durable record of what was there; the timeline reads them live.
    case "context_loaded":
    case "context_read":
    // A handoff's durable record is agent history's (lib/agents/handoff).
    case "handoff_sent":
    case "handoff_received":
      // Deliberately dropped from the durable log. See above.
      return null;
  }
}

/** A control event reduced to what the existing domain log stores, or `null` if it does not belong there. */
export function toDomainEventInput(
  event: AgentControlEvent
): { runId: string; kind: NonNullable<ReturnType<typeof domainEventKindFor>>; summary: string; sourceId?: string } | null {
  const kind = domainEventKindFor(event.kind);
  if (!kind || !event.runId) return null;

  const reduced: {
    runId: string;
    kind: NonNullable<ReturnType<typeof domainEventKindFor>>;
    summary: string;
    sourceId?: string;
  } = {
    runId: event.runId,
    kind,
    summary: normalizeControlSummary(event.summary),
  };

  if (event.sourceId) reduced.sourceId = event.sourceId;
  return reduced;
}
