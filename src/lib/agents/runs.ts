import { createId } from "@/lib/id";
import { findAgent } from "./registry";
import { agentFailure, isTerminalRunStatus } from "./types";
import type { AgentFailure, AgentRun, AgentRunStatus, AgentState } from "./types";

/**
 * Agent runs: creation, metadata, lifecycle and deletion.
 *
 * Pure reducers over AgentState, with the clock injected — same contract as
 * ./registry.ts.
 */

export type CreateRunInput = {
  agentId: string;
  workspaceId: string;
  externalId?: string;
  title?: string;
  /** Defaults to "working"; a run may legitimately start out `waiting`. */
  status?: AgentRunStatus;
};

export type CreateRunResult = { ok: true; state: AgentState; run: AgentRun } | AgentFailure;

/**
 * Starts a run.
 *
 * Both foreign keys are checked rather than trusted: the agent must exist in
 * this state (a run pointing at nothing is unrenderable and undeletable by
 * any normal path), and a workspaceId must actually be supplied. The
 * workspace is *not* validated against a workspace store here — this domain
 * deliberately does not import one — so the caller is responsible for passing
 * a real workspace id. What the domain guarantees is that whatever id is
 * passed is the one every later relationship is checked against.
 */
export function createRun(state: AgentState, input: CreateRunInput, now: number): CreateRunResult {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return agentFailure("invalid-input");
  if (!findAgent(state, input.agentId)) return agentFailure("agent-not-found");

  const status = input.status ?? "working";
  const run: AgentRun = {
    id: createId(),
    agentId: input.agentId,
    workspaceId,
    status,
    createdAt: now,
    updatedAt: now,
  };

  const externalId = input.externalId?.trim();
  if (externalId) run.externalId = externalId;
  const title = input.title?.trim();
  if (title) run.title = title;
  // A run created directly into a terminal status (an import, or a session
  // discovered only after it finished) still needs its terminal timestamp.
  if (isTerminalRunStatus(status)) run.endedAt = now;

  return { ok: true, state: { ...state, runs: [...state.runs, run] }, run };
}

export function findRun(state: AgentState, runId: string): AgentRun | undefined {
  return state.runs.find((run) => run.id === runId);
}

/**
 * The run an adapter has already created for a provider session.
 *
 * Scoped by agent as well as externalId because two providers could
 * plausibly mint the same opaque session string, and a collision would
 * silently merge two unrelated runs.
 */
export function findRunByExternalId(
  state: AgentState,
  agentId: string,
  externalId: string
): AgentRun | undefined {
  return state.runs.find((run) => run.agentId === agentId && run.externalId === externalId);
}

export function listRuns(state: AgentState): AgentRun[] {
  return state.runs;
}

export type UpdateRunPatch = {
  title?: string;
  currentActivity?: string;
  externalId?: string;
};

export type UpdateRunResult = { ok: true; state: AgentState; run: AgentRun } | AgentFailure;

/**
 * Updates a run's descriptive metadata.
 *
 * Two deliberate omissions. `status` is absent because lifecycle changes go
 * through transitionRunStatus, which is the only thing that enforces the
 * terminal rule — allowing status here would be a second, unguarded door into
 * the same field. `workspaceId` is absent because moving a run between
 * workspaces would strand its links on the far side of the boundary.
 *
 * Absent fields are left alone rather than cleared. An observer that learns
 * less on a later poll than it did on an earlier one should not erase what is
 * already known, so "no title in this update" means "no news", not "no
 * title". Clearing is still possible, explicitly, by passing an empty string.
 */
export function updateRun(
  state: AgentState,
  runId: string,
  patch: UpdateRunPatch,
  now: number
): UpdateRunResult {
  const existing = findRun(state, runId);
  if (!existing) return agentFailure("run-not-found");

  const next: AgentRun = { ...existing };
  let changed = false;

  for (const field of ["title", "currentActivity", "externalId"] as const) {
    const raw = patch[field];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value) {
      if (next[field] === value) continue;
      next[field] = value;
    } else {
      if (next[field] === undefined) continue;
      delete next[field];
    }
    changed = true;
  }

  if (!changed) return { ok: true, state, run: existing };

  next.updatedAt = now;
  return {
    ok: true,
    state: { ...state, runs: state.runs.map((r) => (r.id === runId ? next : r)) },
    run: next,
  };
}

export type TransitionRunResult = { ok: true; state: AgentState; run: AgentRun } | AgentFailure;

/**
 * Whether a status change is allowed.
 *
 * The whole policy, in one place and deliberately tiny:
 *
 *   - a terminal run does not transition at all;
 *   - the two live states may swap freely;
 *   - a live state may end in any terminal state.
 *
 * Re-asserting the status a run already has is not a transition and is
 * handled by the caller below, not here.
 */
export function canTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  if (isTerminalRunStatus(from)) return false;
  return from !== to;
}

/**
 * Moves a run to a new status, setting `endedAt` if that status is terminal.
 *
 * Re-asserting the current status is a no-op that succeeds and returns the
 * state unchanged — including `updatedAt`, since nothing materially changed.
 * That matters for the polling adapters a later phase adds: a session that
 * reports "still working" every few seconds must not rewrite the record (and
 * so retrigger every consumer) each time.
 *
 * Attempting to move a terminal run is refused with `terminal-run` rather
 * than `invalid-transition`, so a caller can tell "this run is over" from
 * "that particular hop isn't allowed".
 */
export function transitionRunStatus(
  state: AgentState,
  runId: string,
  next: AgentRunStatus,
  now: number
): TransitionRunResult {
  const existing = findRun(state, runId);
  if (!existing) return agentFailure("run-not-found");

  if (existing.status === next) {
    return isTerminalRunStatus(existing.status)
      ? agentFailure("terminal-run")
      : { ok: true, state, run: existing };
  }
  if (isTerminalRunStatus(existing.status)) return agentFailure("terminal-run");
  if (!canTransition(existing.status, next)) return agentFailure("invalid-transition");

  const run: AgentRun = { ...existing, status: next, updatedAt: now };
  if (isTerminalRunStatus(next)) run.endedAt = now;

  return {
    ok: true,
    state: { ...state, runs: state.runs.map((r) => (r.id === runId ? run : r)) },
    run,
  };
}

export type DeleteRunResult = { ok: true; state: AgentState } | AgentFailure;

/**
 * Deletes a run and everything that hangs off it.
 *
 * Links and events have no meaning without their run — a link is "this run
 * touched this tab" and an event is "this run did this" — so they go with it.
 * The agent, which outlives any single run, does not.
 *
 * Artifact *links* go too, for the same reason. The artifacts themselves do
 * not: a file worked on by two runs outlives the deletion of one of them.
 * Artifacts left referenced by nothing are collected by
 * pruneOrphanedArtifacts, which the caller applies when it wants that.
 *
 * Work items go with the run unconditionally, and unlike artifacts there is
 * no shared-ownership case to consider: a work item belongs to exactly one
 * run, so nothing else can still refer to it once that run is gone.
 */
export function deleteRun(state: AgentState, runId: string): DeleteRunResult {
  if (!findRun(state, runId)) return agentFailure("run-not-found");

  return {
    ok: true,
    state: {
      ...state,
      runs: state.runs.filter((run) => run.id !== runId),
      links: state.links.filter((link) => link.runId !== runId),
      events: state.events.filter((event) => event.runId !== runId),
      artifactLinks: state.artifactLinks.filter((link) => link.runId !== runId),
      workItems: state.workItems.filter((item) => item.runId !== runId),
    },
  };
}
