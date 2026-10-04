import { isWellFormedControlEvent } from "@/lib/agents/control/events";
import { isAgentSessionStatus, isTerminalSessionStatus } from "@/lib/agents/control/session";
import { isAgentProviderId } from "@/lib/agents/connectors/types";
import { handoffLinksOf, readHandoffLinks, readSessionHandoff } from "@/lib/agents/handoff/handoff";
import type { SessionHandoff, SessionHandoffLinks } from "@/lib/agents/handoff/handoff";
import type { AppliedWorkspaceChange, WorkspaceChangeStep } from "@/lib/agents/command-centre/workspace-activity";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentControlEventKind } from "@/lib/agents/control/events";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import type { Collection } from "@/lib/collections/types";
import type {
  RuntimeApprovalView,
  RuntimePlanOutcomeView,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";

/**
 * Agent history: an agent session's activity, kept after the runtime that
 * hosted it is gone.
 *
 *     Workspace → Agent session → Activity → Action → Result
 *
 * ## One event model, kept — not a second one
 *
 * What is kept is the very records the live timeline is built from
 * (./timeline.ts, ./inspector.ts): the runtime's canonical control events,
 * the approvals they reference, the workspace changes the Command Centre
 * applied, and each plan's verified outcome. Nothing here is a summary, a
 * rendered row or a new vocabulary. Read back, they go through the same
 * `buildAgentActivityTimeline` and `inspectActivityEntry` the live session
 * uses, so a session looks the same the day after as it did while it ran —
 * and every relationship is the one the runtime recorded (`approvalId`,
 * `changeId`, `planId`), never one inferred from a time or a title.
 *
 * ## What is not kept
 *
 * The live wire is richer than history needs, and the difference is dropped
 * on the way in rather than filtered on the way out — a value never written
 * cannot leak through a later reader, a backup or a `SELECT *`:
 *
 *   - **No conversation.** `text` is never kept on any event, and
 *     `thinking` / `message_delta` are not kept at all: they are transport,
 *     not activity. That a message was sent or answered is kept; what it said
 *     is not.
 *   - **No command line.** An approval's `command` preview (program,
 *     arguments, working directory) is dropped, and so are its targets unless
 *     they are the project-relative files the timeline names.
 *   - **No tab titles.** An approval's change and plan keep their names and
 *     counts; the sample tab titles and "moves from" lines shown on the card
 *     are dropped.
 *   - **No free-text summary** except on the two kinds the timeline reads one
 *     from (`approval_requested`, `error`) — already bounded and adapter-authored.
 *   - **No credential of any kind.** The control event has nowhere to put
 *     one, and nothing here adds a field that could.
 *
 * What stays beyond names and counts is the collection snapshot either side
 * of an applied change (`before` / `after`: ids, names and tab ids — no URL,
 * no title). It is the exact inverse undo needs; without it a historical
 * change could never be undone safely, and with anything less it would have
 * to be guessed. It is bounded, and dropped whole when it is not.
 */

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export const HISTORY_LIMITS = {
  /** Events kept per session. Beyond it the session is marked `truncated` and no further event is kept. */
  eventsPerSession: 1_000,
  /** Sessions in one page of a workspace's history. */
  pageSize: 20,
  maxPageSize: 50,
  /** An applied change's before/after snapshot, serialized. Beyond it the change is kept without undo. */
  snapshotBytes: 256_000,
  collections: 500,
  tabIdsPerCollection: 5_000,
  steps: 50,
  targets: 50,
  text: 500,
  id: 200,
} as const;

/** Live-wire kinds history does not keep. Transport, not activity. */
const TRANSPORT_KINDS: ReadonlySet<AgentControlEventKind> = new Set(["thinking", "message_delta"]);

/** Kinds whose `summary` the timeline reads. Every other kind is kept with an empty one. */
const SUMMARY_KINDS: ReadonlySet<AgentControlEventKind> = new Set(["approval_requested", "error"]);

/** Approval actions whose targets are project-relative files the timeline names. */
const FILE_ACTIONS: ReadonlySet<string> = new Set(["create_files", "modify_files", "delete_files"]);

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** One agent session as history keeps it. Every field is the session's own; nothing is generated. */
export type AgentHistorySession = {
  sessionId: string;
  /** Every history session belongs to exactly one workspace. A session with none is not kept. */
  workspaceId: string;
  provider: AgentProviderId;
  /** As last recorded. A live status read back from history means the runtime stopped; see `historySessionStatus`. */
  status: AgentSessionStatus;
  title?: string;
  /** Hubble's project id, so a file result can name its project. Never a path. */
  projectId?: string;
  /** The session started without Hubble's workspace tools (`RuntimeSessionView.contextUnavailable`). */
  contextUnavailable?: boolean;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  /** More events happened than history keeps; the ones kept are the first. */
  truncated?: boolean;
  /**
   * The handoffs this session was part of (Hubble 1.4), from the explicit
   * handoff records — the work it was handed, and what it handed on.
   */
  handoff?: SessionHandoffLinks;
};

/** An undo the person made, recorded as its own fact after the change it undid. */
export type AgentHistoryUndo = { changeId: string; at: number };

/** The records one session's timeline and inspector are built from. */
export type AgentHistoryRecords = {
  events: readonly SequencedControlEvent[];
  approvals: readonly RuntimeApprovalView[];
  /** As applied — never carrying `undone`; undos are their own records. */
  changes: readonly AppliedWorkspaceChange[];
  undos: readonly AgentHistoryUndo[];
  planOutcomes: readonly RuntimePlanOutcomeView[];
  /** Handoffs this session was the source or the target of (Hubble 1.4). Absent: none, or none kept. */
  handoffs?: readonly SessionHandoff[];
};

export type AgentHistoryDetail = { session: AgentHistorySession; records: AgentHistoryRecords };

/** One page of a workspace's history, newest first. */
export type AgentHistoryPage = {
  sessions: readonly AgentHistorySession[];
  /** Where the next (older) page starts. Absent on the last page. */
  next?: AgentHistoryCursor;
};

/** Keyset position: strictly older than this session in (lastActivityAt, sessionId) order. */
export type AgentHistoryCursor = { lastActivityAt: number; sessionId: string };

/** One stored record, as the store keeps it: a kind, a stable key and the record itself. */
export type AgentHistoryRecord =
  | { kind: "event"; key: string; at: number; data: SequencedControlEvent }
  | { kind: "approval"; key: string; at: number; data: RuntimeApprovalView }
  | { kind: "change"; key: string; at: number; data: AppliedWorkspaceChange }
  | { kind: "undo"; key: string; at: number; data: AgentHistoryUndo }
  | { kind: "plan_outcome"; key: string; at: number; data: RuntimePlanOutcomeView };

export type AgentHistoryRecordKind = AgentHistoryRecord["kind"];

export const HISTORY_RECORD_KINDS: readonly AgentHistoryRecordKind[] = ["event", "approval", "change", "undo", "plan_outcome"];

/* ------------------------------------------------------------------ *
 * Live → durable
 * ------------------------------------------------------------------ */

/**
 * The key that makes an event idempotent in history: the journal's own
 * identity for it, so a replay (a remote host re-reads its sandbox log on
 * every request) writes nothing twice.
 */
export function eventRecordKey(event: SequencedControlEvent): string {
  return event.sourceId ? `src:${event.provider}:${event.sourceId}` : `evt:${event.id}`;
}

/** An event as history keeps it, or `null` for one it does not keep. */
export function historyEventOf(event: SequencedControlEvent): SequencedControlEvent | null {
  if (TRANSPORT_KINDS.has(event.kind)) return null;
  const kept: SequencedControlEvent = {
    id: event.id,
    sessionId: event.sessionId,
    provider: event.provider,
    kind: event.kind,
    timestamp: event.timestamp,
    sequence: event.sequence,
    summary: SUMMARY_KINDS.has(event.kind) ? event.summary : "",
  };
  if (event.runId) kept.runId = event.runId;
  if (event.tool) {
    kept.tool = {
      name: event.tool.name,
      ...(event.tool.description ? { description: event.tool.description } : {}),
      ...(event.tool.callId ? { callId: event.tool.callId } : {}),
      ...(event.tool.ok !== undefined ? { ok: event.tool.ok } : {}),
    };
  }
  if (event.file) kept.file = { relativePath: event.file.relativePath, projectId: event.file.projectId };
  if (event.approvalId) kept.approvalId = event.approvalId;
  if (event.context) kept.context = { ...event.context };
  if (event.handoff) kept.handoff = { ...event.handoff };
  if (event.messageId) kept.messageId = event.messageId;
  if (event.sourceId) kept.sourceId = event.sourceId;
  // `text` is never copied. See the note at the top of this file.
  return kept;
}

/** An approval as history keeps it: what the timeline and inspector say about it, and no more. */
export function historyApprovalOf(view: RuntimeApprovalView): RuntimeApprovalView {
  const kept: RuntimeApprovalView = {
    approvalId: view.approvalId,
    sessionId: view.sessionId,
    provider: view.provider,
    action: view.action,
    scope: view.scope,
    ...(view.projectId ? { projectId: view.projectId } : {}),
    ...(view.workspaceId ? { workspaceId: view.workspaceId } : {}),
    // Files only: anything else here could be a description of a command.
    targets: FILE_ACTIONS.has(view.action) ? view.targets.slice(0, HISTORY_LIMITS.targets) : [],
    requestedAt: view.requestedAt,
    expiresAt: view.expiresAt,
  };
  if (view.runId) kept.runId = view.runId;
  if (view.reason) kept.reason = view.reason.slice(0, HISTORY_LIMITS.text);
  if (view.change) {
    kept.change = {
      kind: view.change.kind,
      subject: view.change.subject,
      ...(view.change.to !== undefined ? { to: view.change.to } : {}),
      ...(view.change.tabCount !== undefined ? { tabCount: view.change.tabCount } : {}),
      details: [],
    };
  }
  if (view.plan) {
    kept.plan = {
      planId: view.plan.planId,
      basedOnVersion: view.plan.basedOnVersion,
      operationCount: view.plan.operationCount,
      tabCount: view.plan.tabCount,
      steps: view.plan.steps.slice(0, HISTORY_LIMITS.steps).map((step) => ({
        kind: step.kind,
        subject: step.subject,
        ...(step.to !== undefined ? { to: step.to } : {}),
        ...(step.tabCount !== undefined ? { tabCount: step.tabCount } : {}),
        tabs: [],
        movesFrom: [],
      })),
    };
  }
  // `command` is never copied.
  return kept;
}

/**
 * An applied change as history keeps it: as applied, with no undo state —
 * an undo is recorded separately, so the original is never rewritten. The
 * snapshot either side is kept only whole and only within its bound.
 */
export function historyChangeOf(change: AppliedWorkspaceChange): AppliedWorkspaceChange {
  const kept: AppliedWorkspaceChange = {
    id: change.id,
    sessionId: change.sessionId,
    provider: change.provider,
    workspaceId: change.workspaceId,
    at: change.at,
    ok: change.ok,
    ...(change.planId ? { planId: change.planId } : {}),
    ...(change.approvalId ? { approvalId: change.approvalId } : {}),
    steps: change.steps.slice(0, HISTORY_LIMITS.steps).map((step) => ({ ...step })),
  };
  const snapshot = change.before && change.after ? reviveSnapshot(change.before, change.after, change.workspaceId) : null;
  if (snapshot) {
    kept.before = snapshot.before;
    kept.after = snapshot.after;
  }
  return kept;
}

export function historyOutcomeOf(outcome: RuntimePlanOutcomeView): RuntimePlanOutcomeView {
  return {
    planId: outcome.planId,
    ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
    status: outcome.status,
    operationCount: outcome.operationCount,
    verifiedCount: outcome.verifiedCount,
    contextVersion: outcome.contextVersion,
    at: outcome.at,
  };
}

/* ------------------------------------------------------------------ *
 * Durable → live model (untrusted on the way back)
 * ------------------------------------------------------------------ *
 *
 * Every record is revalidated when it is read — from the database, which a
 * newer version or a person may have written, and again in the browser from
 * the wire. A record that does not read is dropped, never repaired: history
 * says less rather than something that did not happen.
 */

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= HISTORY_LIMITS.id;
const isText = (value: unknown, max: number = HISTORY_LIMITS.text): value is string => typeof value === "string" && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;

export function reviveHistoryEvent(raw: unknown, sessionId: string): SequencedControlEvent | null {
  if (!isRecord(raw)) return null;
  if (raw.sessionId !== sessionId || !isAgentProviderId(raw.provider)) return null;
  if (typeof raw.sequence !== "number" || !Number.isInteger(raw.sequence) || raw.sequence < 1) return null;
  if (typeof raw.summary !== "string" || raw.text !== undefined) return null;
  if (!isId(raw.id) || typeof raw.kind !== "string" || !isTime(raw.timestamp)) return null;
  for (const key of ["runId", "approvalId", "messageId", "sourceId"] as const) {
    if (raw[key] !== undefined && !isId(raw[key])) return null;
  }
  if (raw.tool !== undefined) {
    const tool = raw.tool;
    if (!isRecord(tool) || typeof tool.name !== "string" || (tool.description !== undefined && !isText(tool.description, 200))) return null;
    if ((tool.callId !== undefined && !isId(tool.callId)) || (tool.ok !== undefined && typeof tool.ok !== "boolean")) return null;
  }
  if (raw.file !== undefined) {
    const file = raw.file;
    if (!isRecord(file) || !isText(file.relativePath, 1_000) || !file.relativePath || !isId(file.projectId)) return null;
  }
  const event = historyEventOf(raw as unknown as SequencedControlEvent);
  if (!event || !isWellFormedControlEvent(event)) return null;
  return event;
}

const STEP_KINDS = new Set(["create_collection", "rename_collection", "add_tabs_to_collection"]);

function reviveApprovalStep(raw: unknown): { kind: string; subject: string; to?: string; tabCount?: number } | null {
  if (!isRecord(raw) || !STEP_KINDS.has(raw.kind as string) || !isText(raw.subject)) return null;
  if (raw.to !== undefined && !isText(raw.to)) return null;
  if (raw.tabCount !== undefined && !isCount(raw.tabCount)) return null;
  return {
    kind: raw.kind as string,
    subject: raw.subject,
    ...(raw.to !== undefined ? { to: raw.to as string } : {}),
    ...(raw.tabCount !== undefined ? { tabCount: raw.tabCount as number } : {}),
  };
}

export function reviveHistoryApproval(raw: unknown, sessionId: string): RuntimeApprovalView | null {
  if (!isRecord(raw)) return null;
  if (!isId(raw.approvalId) || raw.sessionId !== sessionId || !isAgentProviderId(raw.provider)) return null;
  if (!isText(raw.action, 64) || !isText(raw.scope, 64)) return null;
  if (!isTime(raw.requestedAt) || !isTime(raw.expiresAt)) return null;
  if (!Array.isArray(raw.targets) || raw.targets.length > HISTORY_LIMITS.targets || !raw.targets.every((target) => isText(target))) return null;
  if (raw.projectId !== undefined && !isId(raw.projectId)) return null;
  if (raw.workspaceId !== undefined && !isId(raw.workspaceId)) return null;
  if (raw.runId !== undefined && !isId(raw.runId)) return null;
  if (raw.reason !== undefined && !isText(raw.reason)) return null;

  const view: RuntimeApprovalView = {
    approvalId: raw.approvalId,
    sessionId,
    provider: raw.provider,
    action: raw.action,
    scope: raw.scope,
    targets: raw.targets as string[],
    requestedAt: raw.requestedAt,
    expiresAt: raw.expiresAt,
    ...(raw.projectId ? { projectId: raw.projectId as string } : {}),
    ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
    ...(raw.runId ? { runId: raw.runId as string } : {}),
    ...(raw.reason ? { reason: raw.reason as string } : {}),
  };
  if (raw.change !== undefined) {
    const step = reviveApprovalStep(raw.change);
    if (!step) return null;
    view.change = { ...(step as Omit<NonNullable<RuntimeApprovalView["change"]>, "details">), details: [] };
  }
  if (raw.plan !== undefined) {
    const plan = raw.plan;
    if (!isRecord(plan) || !isId(plan.planId) || !isCount(plan.basedOnVersion) || !isCount(plan.operationCount) || !isCount(plan.tabCount)) {
      return null;
    }
    if (!Array.isArray(plan.steps) || plan.steps.length > HISTORY_LIMITS.steps) return null;
    const steps = plan.steps.map(reviveApprovalStep);
    if (steps.some((step) => step === null)) return null;
    view.plan = {
      planId: plan.planId,
      basedOnVersion: plan.basedOnVersion,
      operationCount: plan.operationCount,
      tabCount: plan.tabCount,
      steps: steps.map((step) => ({ ...(step as Omit<NonNullable<RuntimeApprovalView["plan"]>["steps"][number], "tabs" | "movesFrom">), tabs: [], movesFrom: [] })),
    };
  }
  return historyApprovalOf(view);
}

function reviveChangeStep(raw: unknown): WorkspaceChangeStep | null {
  if (!isRecord(raw) || !isText(raw.name)) return null;
  const collectionId = raw.collectionId;
  if (collectionId !== undefined && !isId(collectionId)) return null;
  switch (raw.kind) {
    case "created":
      return isCount(raw.tabCount)
        ? { kind: "created", ...(collectionId ? { collectionId: collectionId as string } : {}), name: raw.name, tabCount: raw.tabCount }
        : null;
    case "renamed":
      if (!collectionId || (raw.previousName !== undefined && !isText(raw.previousName))) return null;
      return { kind: "renamed", collectionId: collectionId as string, name: raw.name, ...(raw.previousName !== undefined ? { previousName: raw.previousName as string } : {}) };
    case "added":
      return collectionId && isCount(raw.tabCount) ? { kind: "added", collectionId: collectionId as string, name: raw.name, tabCount: raw.tabCount } : null;
    default:
      return null;
  }
}

function reviveCollection(raw: unknown, workspaceId: string): Collection | null {
  if (!isRecord(raw) || !isId(raw.id) || raw.workspaceId !== workspaceId || !isText(raw.name)) return null;
  if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) return null;
  if (!Array.isArray(raw.tabIds) || raw.tabIds.length > HISTORY_LIMITS.tabIdsPerCollection || !raw.tabIds.every(isId)) return null;
  // Rebuilt with the type's own key order, so a snapshot compares exactly
  // (`collectionsMatch` compares serialized) whichever order it was stored in.
  return { id: raw.id, workspaceId, name: raw.name, tabIds: [...(raw.tabIds as string[])], createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}

/** Both halves of an undo snapshot, or neither: half a snapshot is not an inverse. */
function reviveSnapshot(before: unknown, after: unknown, workspaceId: string): { before: Collection[]; after: Collection[] } | null {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  if (before.length > HISTORY_LIMITS.collections || after.length > HISTORY_LIMITS.collections) return null;
  const revivedBefore = before.map((entry) => reviveCollection(entry, workspaceId));
  const revivedAfter = after.map((entry) => reviveCollection(entry, workspaceId));
  if (revivedBefore.some((entry) => entry === null) || revivedAfter.some((entry) => entry === null)) return null;
  const snapshot = { before: revivedBefore as Collection[], after: revivedAfter as Collection[] };
  if (JSON.stringify(snapshot).length > HISTORY_LIMITS.snapshotBytes) return null;
  return snapshot;
}

export function reviveHistoryChange(raw: unknown, session: { sessionId: string; workspaceId: string }): AppliedWorkspaceChange | null {
  if (!isRecord(raw)) return null;
  if (!isId(raw.id) || raw.sessionId !== session.sessionId || raw.workspaceId !== session.workspaceId) return null;
  if (!isAgentProviderId(raw.provider) || !isTime(raw.at) || typeof raw.ok !== "boolean") return null;
  if (raw.planId !== undefined && !isId(raw.planId)) return null;
  if (raw.approvalId !== undefined && !isId(raw.approvalId)) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length > HISTORY_LIMITS.steps) return null;
  const steps = raw.steps.map(reviveChangeStep);
  if (steps.some((step) => step === null)) return null;
  const change: AppliedWorkspaceChange = {
    id: raw.id,
    sessionId: session.sessionId,
    provider: raw.provider,
    workspaceId: session.workspaceId,
    at: raw.at,
    ok: raw.ok,
    ...(raw.planId ? { planId: raw.planId as string } : {}),
    ...(raw.approvalId ? { approvalId: raw.approvalId as string } : {}),
    steps: steps as WorkspaceChangeStep[],
  };
  // A failed change changed nothing, so there is nothing to put back.
  if (raw.ok) {
    const snapshot = reviveSnapshot(raw.before, raw.after, session.workspaceId);
    if (snapshot) {
      change.before = snapshot.before;
      change.after = snapshot.after;
    }
  }
  return change;
}

export function reviveHistoryUndo(raw: unknown): AgentHistoryUndo | null {
  if (!isRecord(raw) || !isId(raw.changeId) || !isTime(raw.at)) return null;
  return { changeId: raw.changeId, at: raw.at };
}

const OUTCOME_STATUSES = new Set(["applied", "unverified", "not_applied", "stale", "denied", "expired", "cancelled"]);

export function reviveHistoryOutcome(raw: unknown): RuntimePlanOutcomeView | null {
  if (!isRecord(raw) || !isId(raw.planId) || !OUTCOME_STATUSES.has(raw.status as string)) return null;
  if (!isCount(raw.operationCount) || !isCount(raw.verifiedCount) || !isCount(raw.contextVersion) || !isTime(raw.at)) return null;
  if (raw.approvalId !== undefined && !isId(raw.approvalId)) return null;
  return historyOutcomeOf(raw as unknown as RuntimePlanOutcomeView);
}

export function reviveHistorySession(raw: unknown): AgentHistorySession | null {
  if (!isRecord(raw)) return null;
  if (!isId(raw.sessionId) || !isId(raw.workspaceId) || !isAgentProviderId(raw.provider)) return null;
  if (!isAgentSessionStatus(raw.status) || !isTime(raw.startedAt) || !isTime(raw.lastActivityAt)) return null;
  if (raw.title !== undefined && !isText(raw.title, 200)) return null;
  if (raw.projectId !== undefined && !isId(raw.projectId)) return null;
  if (raw.endedAt !== undefined && !isTime(raw.endedAt)) return null;
  return {
    sessionId: raw.sessionId,
    workspaceId: raw.workspaceId,
    provider: raw.provider,
    status: raw.status,
    ...(raw.title ? { title: raw.title as string } : {}),
    ...(raw.projectId ? { projectId: raw.projectId as string } : {}),
    ...(raw.contextUnavailable === true ? { contextUnavailable: true } : {}),
    startedAt: raw.startedAt,
    lastActivityAt: raw.lastActivityAt,
    ...(raw.endedAt !== undefined ? { endedAt: raw.endedAt as number } : {}),
    ...(raw.truncated === true ? { truncated: true } : {}),
    ...(() => {
      const handoff = readHandoffLinks(raw.handoff);
      return handoff ? { handoff } : {};
    })(),
  };
}

/**
 * The handoffs a session's history may show: readable, in its workspace, and
 * naming it as source or target. Anything else is dropped, never repaired.
 */
export function readHistoryHandoffs(raw: unknown, session: { sessionId: string; workspaceId: string }): SessionHandoff[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 100)
    .map(readSessionHandoff)
    .filter(
      (handoff): handoff is SessionHandoff =>
        handoff !== null &&
        handoff.workspaceId === session.workspaceId &&
        (handoff.sourceSessionId === session.sessionId || handoff.targetSessionId === session.sessionId)
    );
}

/** One stored record, revalidated for its session. `null`: unreadable, and so not shown. */
export function reviveHistoryRecord(
  kind: unknown,
  data: unknown,
  session: { sessionId: string; workspaceId: string }
): AgentHistoryRecord | null {
  switch (kind) {
    case "event": {
      const event = reviveHistoryEvent(data, session.sessionId);
      return event ? { kind, key: eventRecordKey(event), at: event.timestamp, data: event } : null;
    }
    case "approval": {
      const approval = reviveHistoryApproval(data, session.sessionId);
      return approval ? { kind, key: approval.approvalId, at: approval.requestedAt, data: approval } : null;
    }
    case "change": {
      const change = reviveHistoryChange(data, session);
      return change ? { kind, key: change.id, at: change.at, data: change } : null;
    }
    case "undo": {
      const undo = reviveHistoryUndo(data);
      return undo ? { kind, key: undo.changeId, at: undo.at, data: undo } : null;
    }
    case "plan_outcome": {
      const outcome = reviveHistoryOutcome(data);
      return outcome ? { kind, key: outcome.planId, at: outcome.at, data: outcome } : null;
    }
    default:
      return null;
  }
}

/** Sorts revived records into the shape the builder reads. */
export function groupHistoryRecords(records: readonly AgentHistoryRecord[]): AgentHistoryRecords {
  const grouped = { events: [] as SequencedControlEvent[], approvals: [] as RuntimeApprovalView[], changes: [] as AppliedWorkspaceChange[], undos: [] as AgentHistoryUndo[], planOutcomes: [] as RuntimePlanOutcomeView[] };
  for (const record of records) {
    switch (record.kind) {
      case "event":
        grouped.events.push(record.data);
        break;
      case "approval":
        grouped.approvals.push(record.data);
        break;
      case "change":
        grouped.changes.push(record.data);
        break;
      case "undo":
        grouped.undos.push(record.data);
        break;
      case "plan_outcome":
        grouped.planOutcomes.push(record.data);
        break;
    }
  }
  grouped.events.sort((a, b) => a.sequence - b.sequence);
  grouped.changes.sort((a, b) => a.at - b.at);
  return grouped;
}

/** A whole session as it arrives over the wire, revalidated. `null` when the session itself does not read. */
export function readHistoryDetail(raw: unknown): AgentHistoryDetail | null {
  if (!isRecord(raw)) return null;
  const session = reviveHistorySession(raw.session);
  if (!session || !isRecord(raw.records)) return null;
  const input = raw.records;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const revived: AgentHistoryRecord[] = [];
  const push = (kind: AgentHistoryRecordKind, values: unknown) => {
    for (const value of list(values)) {
      const record = reviveHistoryRecord(kind, value, session);
      if (record) revived.push(record);
    }
  };
  push("event", input.events);
  push("approval", input.approvals);
  push("change", input.changes);
  push("undo", input.undos);
  push("plan_outcome", input.planOutcomes);
  const records = groupHistoryRecords(revived);
  const handoffs = readHistoryHandoffs(input.handoffs, session);
  return { session, records: handoffs.length > 0 ? { ...records, handoffs } : records };
}

export function readHistoryPage(raw: unknown): AgentHistoryPage | null {
  if (!isRecord(raw) || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.map(reviveHistorySession).filter((session): session is AgentHistorySession => session !== null);
  const next = isRecord(raw.next) && isTime(raw.next.lastActivityAt) && isId(raw.next.sessionId)
    ? { lastActivityAt: raw.next.lastActivityAt, sessionId: raw.next.sessionId }
    : undefined;
  return { sessions, ...(next ? { next } : {}) };
}

/* ------------------------------------------------------------------ *
 * Reconstruction
 * ------------------------------------------------------------------ */

/**
 * A recorded status as it is true *now*, for a session no runtime holds.
 *
 * A session recorded as `running` is not running: the process that drove it
 * is gone (that is why it is being read from history). It reads as
 * `disconnected` — the same rule `control/persistence.ts` applies to a
 * session restored after a reload. A terminal status is kept as recorded.
 */
export function historySessionStatus(status: AgentSessionStatus): AgentSessionStatus {
  return isTerminalSessionStatus(status) ? status : "disconnected";
}

/** The builder's inputs, from history — the same shapes the live session passes. */
export type ReconstructedHistorySession = {
  session: RuntimeSessionView;
  events: readonly SequencedControlEvent[];
  knownApprovals: ReadonlyMap<string, RuntimeApprovalView>;
  changes: readonly AppliedWorkspaceChange[];
  planOutcomes: readonly RuntimePlanOutcomeView[];
  handoffs: readonly SessionHandoff[];
};

/**
 * Puts a session read from history back into the live model, so
 * `buildAgentActivityTimeline` and `inspectActivityEntry` take it unchanged.
 *
 * Nothing live is claimed: no approval is pending, nothing is cancellable or
 * resumable, there are no runs to drive and no context bound. Each undo is
 * folded onto the change it undid — exactly how the live record carries one
 * (`markWorkspaceChangeUndone`) — and the first undo wins.
 */
export function reconstructHistorySession(detail: AgentHistoryDetail): ReconstructedHistorySession {
  const { session, records } = detail;
  const undoneAt = new Map<string, number>();
  for (const undo of records.undos) if (!undoneAt.has(undo.changeId)) undoneAt.set(undo.changeId, undo.at);

  const view: RuntimeSessionView = {
    sessionId: session.sessionId,
    provider: session.provider,
    status: historySessionStatus(session.status),
    runIds: [],
    awaitingApproval: false,
    cancellable: false,
    resumable: false,
    latestSequence: records.events.reduce((latest, event) => Math.max(latest, event.sequence), 0),
    createdAt: session.startedAt,
    updatedAt: session.lastActivityAt,
    workspaceId: session.workspaceId,
    ...(session.title ? { title: session.title } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.contextUnavailable ? { contextUnavailable: "provider" as const } : {}),
  };
  // The relationship as the handoff records state it, or as the session row did.
  const handoff = handoffLinksOf(session.sessionId, records.handoffs ?? []) ?? session.handoff;
  if (handoff) view.handoff = handoff;

  return {
    session: view,
    events: records.events,
    knownApprovals: new Map(records.approvals.map((approval) => [approval.approvalId, approval])),
    changes: records.changes.map((change) => {
      const at = undoneAt.get(change.id);
      return at !== undefined && change.ok ? { ...change, undone: true, undoneAt: at } : change;
    }),
    planOutcomes: records.planOutcomes,
    handoffs: records.handoffs ?? [],
  };
}
