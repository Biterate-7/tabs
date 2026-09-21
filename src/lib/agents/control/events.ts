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
  | "run_cancelled";

export const AGENT_CONTROL_EVENT_KINDS: readonly AgentControlEventKind[] = [
  "session_started",
  "session_resumed",
  "message_sent",
  "message_received",
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
  /** The project this path is relative to, by TabDump's project id — never a path. */
  projectId: string;
};

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
