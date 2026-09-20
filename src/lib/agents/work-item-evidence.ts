import {
  MAX_EVIDENCE_PER_WORK_ITEM,
  agentFailure,
  isAgentWorkItemEvidenceKind,
} from "./types";
import type {
  AgentFailure,
  AgentState,
  AgentWorkItemEvidence,
  AgentWorkItemEvidenceKind,
} from "./types";

/**
 * Task-level evidence: the write side.
 *
 * ## What this module refuses to do
 *
 * It never derives. There is no function here that takes a run and hands out
 * evidence for its work items, because the join that would produce one - a
 * work item and an artifact link sharing a run - asserts an association
 * nothing observed. See the note on the deliberately absent
 * `work-item -> artifact` relationship in intelligence/types.ts: that refusal
 * still stands, and this module is what makes it survivable. An association
 * exists here only because a caller explicitly reported it.
 *
 * The consequence is worth stating plainly: for a provider that reports no
 * per-task attribution, every work item has zero evidence rows forever, and
 * the Session View says "No recorded evidence for this task." That is the
 * correct output, not a gap to be filled in later by inference.
 *
 * ## The containment rule
 *
 * Evidence can only point at something its own run already touches. An event
 * must belong to the run; a tab must be linked to the run; an artifact must
 * be linked to the run. Each is checked against stored state before a row is
 * written, so a work item cannot become a side door to a tab its run never
 * used, or to a file in another workspace. That check is the reason this
 * module reads `state` rather than accepting a bare target id on trust.
 */

/**
 * The derived id. Same shape as `agentRunLinkId` and for the same reason:
 * re-observing one association must update one row rather than mint another.
 */
export function agentWorkItemEvidenceId(
  workItemId: string,
  kind: AgentWorkItemEvidenceKind,
  targetId: string
): string {
  return `${workItemId}:${kind}:${targetId}`;
}

export type RecordWorkItemEvidenceInput = {
  workItemId: string;
  kind: AgentWorkItemEvidenceKind;
  targetId: string;
};

export type RecordWorkItemEvidenceResult =
  | { ok: true; state: AgentState; evidence: AgentWorkItemEvidence; created: boolean }
  | AgentFailure;

/**
 * Does this run actually touch this thing?
 *
 * The containment rule, in one place. Returns false for a target the run has
 * no stored relationship with, which the caller turns into
 * `evidence-target-not-found` rather than writing a row that would outlive
 * the relationship it claims to refine.
 */
function runTouches(
  state: AgentState,
  runId: string,
  kind: AgentWorkItemEvidenceKind,
  targetId: string
): boolean {
  if (kind === "event") {
    return state.events.some((event) => event.id === targetId && event.runId === runId);
  }
  if (kind === "tab") {
    return state.links.some((link) => link.tabId === targetId && link.runId === runId);
  }
  // An artifact link is checked rather than the artifact itself: a file that
  // exists in the workspace but that this run never opened is not evidence
  // for one of its tasks.
  return state.artifactLinks.some(
    (link) => link.artifactId === targetId && link.runId === runId
  );
}

/**
 * Records that a work item was evidenced by one thing.
 *
 * Idempotent on the derived id: recording the same association twice returns
 * the existing row with `created: false` and an unchanged state, so a poll
 * that re-reports what it reported last time costs nothing and churns no
 * React key.
 */
export function recordWorkItemEvidence(
  state: AgentState,
  input: RecordWorkItemEvidenceInput,
  now: number
): RecordWorkItemEvidenceResult {
  const workItemId = input.workItemId?.trim();
  const targetId = input.targetId?.trim();

  if (!workItemId || !targetId) return agentFailure("invalid-input");
  if (!isAgentWorkItemEvidenceKind(input.kind)) return agentFailure("invalid-input");
  if (!Number.isFinite(now)) return agentFailure("invalid-input");

  const item = state.workItems.find((candidate) => candidate.id === workItemId);
  if (!item) return agentFailure("work-item-not-found");

  const run = state.runs.find((candidate) => candidate.id === item.runId);
  // A work item whose run is gone has no scope to check against. Refused
  // rather than written against the item's denormalised copy, which is the
  // one field that could be stale.
  if (!run) return agentFailure("run-not-found");
  if (run.workspaceId !== item.workspaceId) return agentFailure("cross-workspace");

  if (!runTouches(state, run.id, input.kind, targetId)) {
    return agentFailure("evidence-target-not-found");
  }

  const id = agentWorkItemEvidenceId(workItemId, input.kind, targetId);
  const existing = state.workItemEvidence.find((row) => row.id === id);
  if (existing) return { ok: true, state, evidence: existing, created: false };

  const count = state.workItemEvidence.filter((row) => row.workItemId === workItemId).length;
  // Oldest wins, matching work items themselves. A task's first evidence is
  // what explains it; dropping that to make room for the hundredth row would
  // leave a list that starts in the middle.
  if (count >= MAX_EVIDENCE_PER_WORK_ITEM) return agentFailure("invalid-input");

  const evidence: AgentWorkItemEvidence = {
    id,
    workItemId,
    runId: run.id,
    workspaceId: run.workspaceId,
    kind: input.kind,
    targetId,
    createdAt: now,
  };

  return {
    ok: true,
    state: { ...state, workItemEvidence: [...state.workItemEvidence, evidence] },
    evidence,
    created: true,
  };
}

/** Every evidence row for one work item, oldest first. */
export function getWorkItemEvidenceRows(
  state: AgentState,
  workItemId: string
): AgentWorkItemEvidence[] {
  return state.workItemEvidence
    .filter((row) => row.workItemId === workItemId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Drops every row belonging to a run. Called when a run is deleted. */
export function removeWorkItemEvidenceForRun(state: AgentState, runId: string): AgentState {
  const next = state.workItemEvidence.filter((row) => row.runId !== runId);
  return next.length === state.workItemEvidence.length
    ? state
    : { ...state, workItemEvidence: next };
}

/** Drops every row belonging to a work item. Called when an item is deleted. */
export function removeWorkItemEvidenceForWorkItem(
  state: AgentState,
  workItemId: string
): AgentState {
  const next = state.workItemEvidence.filter((row) => row.workItemId !== workItemId);
  return next.length === state.workItemEvidence.length
    ? state
    : { ...state, workItemEvidence: next };
}

/**
 * Drops rows whose work item, run or target no longer exists.
 *
 * Evidence is the one relationship that points at three different kinds of
 * thing, so it is the one most able to dangle: pruning a tab, capping a run's
 * events, or removing an artifact link all invalidate rows elsewhere. Run
 * after any of those.
 */
export function pruneWorkItemEvidence(state: AgentState): AgentState {
  const itemsById = new Map(state.workItems.map((item) => [item.id, item]));
  const runIds = new Set(state.runs.map((run) => run.id));

  const next = state.workItemEvidence.filter((row) => {
    const item = itemsById.get(row.workItemId);
    if (!item || item.runId !== row.runId) return false;
    if (!runIds.has(row.runId)) return false;
    return runTouches(state, row.runId, row.kind, row.targetId);
  });

  return next.length === state.workItemEvidence.length
    ? state
    : { ...state, workItemEvidence: next };
}
