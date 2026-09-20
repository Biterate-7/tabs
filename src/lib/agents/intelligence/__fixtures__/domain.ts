import { recordArtifactWork } from "@/lib/agents/artifacts";
import { appendRunEvent } from "@/lib/agents/events";
import { addRunLink } from "@/lib/agents/links";
import { createAgent } from "@/lib/agents/registry";
import { createRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { recordWorkItemEvidence } from "@/lib/agents/work-item-evidence";
import { createWorkItem, transitionWorkItem } from "@/lib/agents/work-items";
import type {
  AgentRunArtifactRole,
  AgentRunLinkRole,
  AgentRunStatus,
  AgentState,
  AgentWorkItemEvidenceKind,
  AgentWorkItemStatus,
} from "@/lib/agents/types";

/**
 * Deterministic fixtures for the intelligence tests.
 *
 * Built by calling the **real domain operations** rather than by hand-writing
 * `AgentState` object literals. That distinction matters more than it looks:
 * a literal can express a state the domain would never produce - a completed
 * item with no `completedAt`, a link across workspaces, a work item whose
 * `workspaceId` disagrees with its run's - and a test suite built on those
 * would be verifying behaviour against data that cannot occur, while missing
 * the behaviour that can.
 *
 * Where a test *needs* impossible state (the malformed-data cases in §34), it
 * constructs it explicitly and says so, so the exception is visible.
 *
 * Nothing here reads the filesystem, the network, or any local Claude Code
 * installation. Every value is literal and every timestamp is derived from
 * `T0`, so the same test run produces the same state on any machine - the
 * §45 rule, applied from the start rather than retrofitted.
 */

/** A fixed epoch, so every derived timestamp in a test is predictable. */
export const T0 = 1_700_000_000_000;

/** A project root that is NOT a real path on any machine running these tests. */
export const PROJECT = "/projects/demo";

export type Builder = {
  state: AgentState;
  agentId: string;
};

/** Starts a state with one agent. */
export function withAgent(name = "Claude Code", provider = "claude-code"): Builder {
  const result = createAgent(emptyAgentState(), { provider, name }, T0);
  if (!result.ok) throw new Error(`fixture: createAgent failed (${result.reason})`);
  return { state: result.state, agentId: result.agent.id };
}

/** Adds a run, returning the new state and the run's id. */
export function withRun(
  state: AgentState,
  input: { agentId: string; workspaceId: string; status?: AgentRunStatus; title?: string },
  at = T0
): { state: AgentState; runId: string } {
  const result = createRun(
    state,
    {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.title ? { title: input.title } : {}),
    },
    at
  );
  if (!result.ok) throw new Error(`fixture: createRun failed (${result.reason})`);
  return { state: result.state, runId: result.run.id };
}

/**
 * Adds a work item and drives it to a status through legal transitions.
 *
 * Goes through `transitionWorkItem` rather than writing the status directly,
 * so an item that a test says is `completed` has a real `startedAt` and
 * `completedAt` exactly as the domain would stamp them.
 */
export function withWorkItem(
  state: AgentState,
  input: { runId: string; title: string; status?: AgentWorkItemStatus; summary?: string },
  at = T0
): { state: AgentState; workItemId: string } {
  const created = createWorkItem(
    state,
    {
      runId: input.runId,
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
    },
    at
  );
  if (!created.ok) throw new Error(`fixture: createWorkItem failed (${created.reason})`);

  const target = input.status ?? "pending";
  let next = created.state;

  for (const step of pathTo(target)) {
    const moved = transitionWorkItem(next, created.workItem.id, step, at + 1);
    if (!moved.ok) throw new Error(`fixture: transition to ${step} failed (${moved.reason})`);
    next = moved.state;
  }

  return { state: next, workItemId: created.workItem.id };
}

/**
 * The legal route from `pending` to a target status.
 *
 * Mirrors ALLOWED_TRANSITIONS in work-items.ts: `completed` is reachable only
 * through `active`, and `blocked` only from `active`.
 */
function pathTo(target: AgentWorkItemStatus): AgentWorkItemStatus[] {
  switch (target) {
    case "pending":
      return [];
    case "active":
      return ["active"];
    case "blocked":
      return ["active", "blocked"];
    case "completed":
      return ["active", "completed"];
    case "cancelled":
      return ["cancelled"];
  }
}

/** Links a tab to a run. `tabWorkspaceId` defaults to the run's own workspace. */
export function withTabLink(
  state: AgentState,
  input: { runId: string; tabId: string; role: AgentRunLinkRole; tabWorkspaceId?: string },
  at = T0
): AgentState {
  const run = state.runs.find((candidate) => candidate.id === input.runId);
  if (!run) throw new Error("fixture: no such run");

  const result = addRunLink(
    state,
    {
      runId: input.runId,
      tabId: input.tabId,
      role: input.role,
      tabWorkspaceId: input.tabWorkspaceId ?? run.workspaceId,
    },
    at
  );
  if (!result.ok) throw new Error(`fixture: addRunLink failed (${result.reason})`);
  return result.state;
}

/** Records that a run worked on a file. */
export function withArtifact(
  state: AgentState,
  input: { runId: string; path: string; role: AgentRunArtifactRole; projectPath?: string },
  at = T0
): { state: AgentState; artifactId: string } {
  const result = recordArtifactWork(
    state,
    {
      runId: input.runId,
      projectPath: input.projectPath ?? PROJECT,
      path: input.path,
      role: input.role,
    },
    at
  );
  if (!result.ok) throw new Error(`fixture: recordArtifactWork failed (${result.reason})`);
  return { state: result.state, artifactId: result.artifact.id };
}

/** Appends one activity event to a run, returning its id as well. */
export function withEvent(
  state: AgentState,
  input: { runId: string; summary: string },
  at = T0
): AgentState {
  return withEventId(state, input, at).state;
}

/**
 * As `withEvent`, but hands back the event's id.
 *
 * Needed by every evidence fixture: attributing an event to a work item
 * requires naming it, and the domain mints the id.
 */
export function withEventId(
  state: AgentState,
  input: { runId: string; summary: string },
  at = T0
): { state: AgentState; eventId: string } {
  const result = appendRunEvent(state, {
    runId: input.runId,
    kind: "activity",
    summary: input.summary,
    timestamp: at,
  });
  if (!result.ok) throw new Error(`fixture: appendRunEvent failed (${result.reason})`);
  return { state: result.state, eventId: result.event.id };
}

/**
 * Records that one thing is evidence for one work item.
 *
 * Goes through the real domain operation, so a fixture cannot express an
 * attribution the domain would refuse - evidence pointing at a tab the run
 * never linked, for instance. That is the property the disjointness tests
 * depend on.
 */
export function withEvidence(
  state: AgentState,
  input: { workItemId: string; kind: AgentWorkItemEvidenceKind; targetId: string },
  at = T0
): AgentState {
  const result = recordWorkItemEvidence(state, input, at);
  if (!result.ok) throw new Error(`fixture: recordWorkItemEvidence failed (${result.reason})`);
  return result.state;
}
