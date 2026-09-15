import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentState, saveAgentState } from "@/lib/agents/persistence";
import { emptyAgentState } from "@/lib/agents/types";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { buildAgentDomainIndex, emptyAgentDomainIndex } from "./domain-index";
import { getAgentRunImpact } from "./impact";
import { getAgentRelationshipsForRun } from "./relationships";
import { getAgentRunSummary } from "./run-summary";
import {
  getActiveAgentRuns,
  getRunsForWorkspace,
  getWorkItemsForWorkspace,
} from "./selectors";
import {
  getWorkspaceActivityCards,
  getWorkspaceAgentActivity,
} from "./workspace-activity";
import {
  T0,
  withAgent,
  withArtifact,
  withEvent,
  withRun,
  withTabLink,
  withWorkItem,
} from "./__fixtures__/domain";
import type { AgentState } from "@/lib/agents/types";

/**
 * Partial, stale and impossible state.
 *
 * Everything here is a situation the running app can genuinely reach — a
 * deletion racing a render, a record written by a build with different rules,
 * a link whose other end is gone — plus a few that only hand-editing storage
 * could produce. The requirement in every case is the same: omit the thing
 * that cannot be trusted, keep everything that can, and never throw.
 *
 * A workspace must not become unreadable because one row is wrong.
 */

/** A complete run, used as the starting point for each act of sabotage. */
function healthy() {
  const base = withAgent();
  const run = withRun(base.state, {
    agentId: base.agentId,
    workspaceId: "w1",
    status: "working",
  });

  let state = withWorkItem(run.state, {
    runId: run.runId,
    title: "Implement authentication",
    status: "active",
  }).state;
  const file = withArtifact(state, {
    runId: run.runId,
    path: "src/auth.ts",
    role: "edited",
  });
  state = file.state;
  state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "context" });
  state = withEvent(state, { runId: run.runId, summary: "Edited auth.ts" }, T0 + 10);

  return { state, runId: run.runId, agentId: base.agentId, artifactId: file.artifactId };
}

describe("missing entities", () => {
  it("survives an empty domain", () => {
    const index = buildAgentDomainIndex(emptyAgentState());

    expect(getRunsForWorkspace(index, "w1")).toEqual([]);
    expect(getWorkItemsForWorkspace(index, "w1")).toEqual([]);
    expect(getActiveAgentRuns(index, "w1")).toEqual([]);
    expect(getWorkspaceActivityCards(index, "w1")).toEqual([]);
    expect(getAgentRunSummary(index, "anything")).toBeUndefined();
    expect(getAgentRunImpact(index, "anything")).toBeUndefined();
    expect(getAgentRelationshipsForRun(index, "anything")).toEqual([]);

    const activity = getWorkspaceAgentActivity(index, "w1");
    expect(activity.activeRuns).toEqual([]);
    expect(activity.lastActivityAt).toBeUndefined();
  });

  it("offers an empty index for a caller that has not loaded yet", () => {
    const index = emptyAgentDomainIndex();
    expect(getWorkspaceAgentActivity(index, "w1").activeRuns).toEqual([]);
    expect(getAgentRunSummary(index, "r")).toBeUndefined();
  });

  it("drops a work item whose run no longer exists", () => {
    const { state, runId } = healthy();
    const orphaned: AgentState = { ...state, runs: state.runs.filter((r) => r.id !== runId) };

    const index = buildAgentDomainIndex(orphaned);
    expect(getWorkItemsForWorkspace(index, "w1")).toEqual([]);
    expect(getWorkspaceAgentActivity(index, "w1").activeWorkItems).toEqual([]);
    // And no fabricated stand-in run appears to hold it.
    expect(getRunsForWorkspace(index, "w1")).toEqual([]);
  });

  it("drops an artifact link whose artifact is gone", () => {
    const { state, runId } = healthy();
    const stale: AgentState = { ...state, artifacts: [] };

    const index = buildAgentDomainIndex(stale);
    const impact = getAgentRunImpact(index, runId)!;

    expect(impact.artifacts).toEqual([]);
    expect(getAgentRunSummary(index, runId)!.artifactCount).toBe(0);
    // The rest of the run is untouched.
    expect(impact.workItems).toHaveLength(1);
    expect(impact.contextTabIds).toEqual(["t1"]);
  });

  it("drops a tab link whose run is gone, without losing other runs", () => {
    const base = withAgent();
    const keep = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const drop = withRun(keep.state, { agentId: base.agentId, workspaceId: "w1" });
    let state = withTabLink(drop.state, { runId: drop.runId, tabId: "t9", role: "context" });
    state = withTabLink(state, { runId: keep.runId, tabId: "t1", role: "context" });

    const pruned: AgentState = {
      ...state,
      runs: state.runs.filter((r) => r.id !== drop.runId),
    };

    const index = buildAgentDomainIndex(pruned);
    expect(getAgentRunImpact(index, keep.runId)!.contextTabIds).toEqual(["t1"]);
    expect(getAgentRunImpact(index, drop.runId)).toBeUndefined();
  });

  it("keeps a run whose agent was deleted", () => {
    const { state, runId } = healthy();
    const orphaned: AgentState = { ...state, agents: [] };

    const index = buildAgentDomainIndex(orphaned);
    // The run is still real work that happened; only its identity is unknown.
    expect(getAgentRunSummary(index, runId)).toBeDefined();
    expect(getWorkspaceActivityCards(index, "w1")[0].agentName).toBe("Agent");
  });

  it("ignores an event whose run is gone", () => {
    const { state, runId } = healthy();
    const orphaned: AgentState = { ...state, runs: state.runs.filter((r) => r.id !== runId) };

    const index = buildAgentDomainIndex(orphaned);
    expect(index.latestEventAtByRun.size).toBe(0);
  });
});

describe("terminal and quiet runs", () => {
  it("summarises a terminal run that produced no events", () => {
    const base = withAgent();
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "failed",
    });

    const index = buildAgentDomainIndex(run.state);
    const summary = getAgentRunSummary(index, run.runId)!;

    expect(summary.status).toBe("failed");
    expect(summary.workItems.total).toBe(0);
    expect(summary.progress).toBeUndefined();
    // Its own updatedAt is still real evidence of when it was last observed.
    expect(summary.lastActivityAt).toBeDefined();
  });

  it("does not turn a quiet run into a finished one", () => {
    const base = withAgent();
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
    });

    const index = buildAgentDomainIndex(run.state);
    const activity = getWorkspaceAgentActivity(index, "w1");

    // No events, no work items, nothing observed since it started. It is
    // still working, because nothing said otherwise.
    expect(activity.byStatus.working.map((r) => r.runId)).toEqual([run.runId]);
    expect(activity.byStatus.completed).toEqual([]);
  });
});

describe("reload recomputes identical intelligence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setStorageNamespace(null);
  });

  afterEach(() => {
    setStorageNamespace(null);
    window.localStorage.clear();
  });

  /**
   * §33's requirement, stated as an equality.
   *
   * Nothing derived is persisted, so the round trip that matters is: derive
   * from live state, save the SOURCE state, load it back, derive again, and
   * compare. Any difference would mean intelligence depends on something
   * outside the persisted domain — a wall clock, an in-memory accumulator, or
   * an ordering that storage does not preserve.
   */
  it("produces the same models before and after a save/load round trip", () => {
    const { state, runId } = healthy();

    const before = {
      summary: getAgentRunSummary(buildAgentDomainIndex(state), runId),
      impact: getAgentRunImpact(buildAgentDomainIndex(state), runId),
      relationships: getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId),
      activity: getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1"),
      cards: getWorkspaceActivityCards(buildAgentDomainIndex(state), "w1"),
    };

    setStorageNamespace("account-1");
    saveAgentState(state);
    const load = loadAgentState();
    expect(load.status).toBe("loaded");

    const reloaded = buildAgentDomainIndex(load.state);
    const after = {
      summary: getAgentRunSummary(reloaded, runId),
      impact: getAgentRunImpact(reloaded, runId),
      relationships: getAgentRelationshipsForRun(reloaded, runId),
      activity: getWorkspaceAgentActivity(reloaded, "w1"),
      cards: getWorkspaceActivityCards(reloaded, "w1"),
    };

    expect(after).toEqual(before);
  });

  it("is deterministic across repeated derivation from one state", () => {
    const { state, runId } = healthy();

    const once = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");
    const twice = getWorkspaceAgentActivity(buildAgentDomainIndex(state), "w1");
    expect(twice).toEqual(once);

    expect(getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId)).toEqual(
      getAgentRelationshipsForRun(buildAgentDomainIndex(state), runId)
    );
  });

  it("does not write anything while deriving", () => {
    const { state, runId } = healthy();
    setStorageNamespace("account-1");
    const before = window.localStorage.length;

    const index = buildAgentDomainIndex(state);
    getAgentRunSummary(index, runId);
    getAgentRunImpact(index, runId);
    getWorkspaceAgentActivity(index, "w1");
    getWorkspaceActivityCards(index, "w1");

    expect(window.localStorage.length).toBe(before);
  });

  it("leaves the source state untouched", () => {
    const { state, runId } = healthy();
    const snapshot = JSON.parse(JSON.stringify(state));

    const index = buildAgentDomainIndex(state);
    getAgentRunSummary(index, runId);
    getAgentRunImpact(index, runId);
    getWorkspaceAgentActivity(index, "w1");

    expect(state).toEqual(snapshot);
  });
});
