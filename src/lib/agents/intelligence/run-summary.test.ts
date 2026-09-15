import { describe, expect, it } from "vitest";
import { getPrimaryWorkItem, getRunWorkProgress } from "@/lib/agents/selectors";
import { AGENT_WORK_ITEM_STATUSES } from "@/lib/agents/types";
import { buildAgentDomainIndex } from "./domain-index";
import {
  countWorkItems,
  deriveLastActivityAt,
  deriveWorkProgress,
  getAgentRunSummary,
  selectPrimaryWorkItem,
} from "./run-summary";
import {
  T0,
  withAgent,
  withArtifact,
  withEvent,
  withRun,
  withTabLink,
  withWorkItem,
} from "./__fixtures__/domain";
import type { AgentState, AgentWorkItemStatus } from "@/lib/agents/types";

/** One run in `w1` with a mix of work-item statuses, files and tabs. */
function populated() {
  const base = withAgent();
  const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });

  let state = run.state;
  for (const [title, status] of [
    ["Implement authentication", "completed"],
    ["Wire the session store", "completed"],
    ["Investigate failing test", "active"],
    ["Write the migration", "pending"],
    ["Drop the legacy path", "cancelled"],
  ] as [string, AgentWorkItemStatus][]) {
    state = withWorkItem(state, { runId: run.runId, title, status }).state;
  }

  state = withArtifact(state, { runId: run.runId, path: "src/auth.ts", role: "edited" }).state;
  state = withArtifact(state, { runId: run.runId, path: "src/auth.ts", role: "inspected" }).state;
  state = withArtifact(state, { runId: run.runId, path: "src/session.ts", role: "edited" }).state;

  state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "context" });
  state = withTabLink(state, { runId: run.runId, tabId: "t2", role: "context" });
  state = withTabLink(state, { runId: run.runId, tabId: "t3", role: "produced" });
  // The same tab in both roles - the agent read a page and then worked on it.
  state = withTabLink(state, { runId: run.runId, tabId: "t1", role: "produced" });

  return { state, runId: run.runId, agentId: base.agentId };
}

describe("work item counts", () => {
  it("partitions every item into exactly one bucket", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);
    const counts = countWorkItems(index.workItemsByRun.get(runId));

    expect(counts).toEqual({
      total: 5,
      pending: 1,
      active: 1,
      blocked: 0,
      completed: 2,
      cancelled: 1,
    });
    // The buckets must sum to the total, or an item has been counted twice or
    // not at all.
    const summed =
      counts.pending + counts.active + counts.blocked + counts.completed + counts.cancelled;
    expect(summed).toBe(counts.total);
  });

  it("counts nothing for a run with no items", () => {
    expect(countWorkItems(undefined)).toEqual({
      total: 0,
      pending: 0,
      active: 0,
      blocked: 0,
      completed: 0,
      cancelled: 0,
    });
  });
});

describe("derived progress", () => {
  it("counts real completions and excludes cancelled from both sides", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);
    // 5 items, 1 cancelled -> 4 countable, 2 completed.
    expect(deriveWorkProgress(index.workItemsByRun.get(runId))).toEqual({
      completed: 2,
      total: 4,
    });
  });

  it("is undefined for a run with no work items, never 0 / 0", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const index = buildAgentDomainIndex(run.state);

    expect(deriveWorkProgress(index.workItemsByRun.get(run.runId))).toBeUndefined();
    expect(getAgentRunSummary(index, run.runId)?.progress).toBeUndefined();
  });

  it("is undefined when every item was cancelled", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const one = withWorkItem(run.state, {
      runId: run.runId,
      title: "Abandoned",
      status: "cancelled",
    });
    const index = buildAgentDomainIndex(one.state);

    expect(deriveWorkProgress(index.workItemsByRun.get(run.runId))).toBeUndefined();
  });

  it("reads as finished when the remaining items were cancelled", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    let state = withWorkItem(run.state, {
      runId: run.runId,
      title: "Done",
      status: "completed",
    }).state;
    state = withWorkItem(state, { runId: run.runId, title: "Dropped", status: "cancelled" }).state;

    const index = buildAgentDomainIndex(state);
    expect(deriveWorkProgress(index.workItemsByRun.get(run.runId))).toEqual({
      completed: 1,
      total: 1,
    });
  });

  /**
   * The duplication guard.
   *
   * `deriveWorkProgress` restates Phase 15's rule so the indexed path stays
   * linear. That is only safe while the two agree, so they are compared
   * directly across every status combination rather than trusted to stay in
   * step by inspection.
   */
  it("agrees with the Phase 15 selector for every status combination", () => {
    for (const a of AGENT_WORK_ITEM_STATUSES) {
      for (const b of AGENT_WORK_ITEM_STATUSES) {
        const base = withAgent();
        const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
        let state = withWorkItem(run.state, { runId: run.runId, title: "A", status: a }).state;
        state = withWorkItem(state, { runId: run.runId, title: "B", status: b }).state;

        const index = buildAgentDomainIndex(state);
        expect(
          deriveWorkProgress(index.workItemsByRun.get(run.runId)),
          `statuses ${a} + ${b}`
        ).toEqual(getRunWorkProgress(state, run.runId));
      }
    }
  });
});

describe("the primary work item", () => {
  it("prefers active over every other status", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    let state = withWorkItem(run.state, {
      runId: run.runId,
      title: "Finished first",
      status: "completed",
    }).state;
    state = withWorkItem(state, { runId: run.runId, title: "Stuck", status: "blocked" }).state;
    const activeItem = withWorkItem(state, {
      runId: run.runId,
      title: "In progress",
      status: "active",
    });

    const index = buildAgentDomainIndex(activeItem.state);
    expect(selectPrimaryWorkItem(index.workItemsByRun.get(run.runId))?.title).toBe("In progress");
  });

  it("falls through the attention order when nothing is active", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    let state = withWorkItem(run.state, { runId: run.runId, title: "Done", status: "completed" })
      .state;
    state = withWorkItem(state, { runId: run.runId, title: "Waiting on X", status: "blocked" })
      .state;

    const index = buildAgentDomainIndex(state);
    expect(selectPrimaryWorkItem(index.workItemsByRun.get(run.runId))?.title).toBe("Waiting on X");
  });

  it("breaks ties by creation order, not by what the title says", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    // The second item is created later and has the more urgent-sounding text.
    // Selection is structural, so the earlier item still wins.
    const first = withWorkItem(
      run.state,
      { runId: run.runId, title: "Ordinary task", status: "active" },
      T0
    );
    const second = withWorkItem(
      first.state,
      { runId: run.runId, title: "URGENT CRITICAL BLOCKER", status: "active" },
      T0 + 5_000
    );

    const index = buildAgentDomainIndex(second.state);
    expect(selectPrimaryWorkItem(index.workItemsByRun.get(run.runId))?.title).toBe(
      "Ordinary task"
    );
  });

  it("has no primary when the run has no items", () => {
    expect(selectPrimaryWorkItem(undefined)).toBeUndefined();
    expect(selectPrimaryWorkItem([])).toBeUndefined();
  });

  it("agrees with the Phase 15 selector", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);

    expect(selectPrimaryWorkItem(index.workItemsByRun.get(runId))?.id).toBe(
      getPrimaryWorkItem(state, runId)?.id
    );
  });
});

describe("last activity", () => {
  it("takes the newest timestamp across run, events, items and links", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" }, T0);
    const withLateEvent = withEvent(
      run.state,
      { runId: run.runId, summary: "Edited auth.ts" },
      T0 + 90_000
    );

    const index = buildAgentDomainIndex(withLateEvent);
    expect(deriveLastActivityAt(index, run.runId)).toBe(T0 + 90_000);
  });

  it("never reports a time later than the newest evidence", () => {
    const { state, runId } = populated();
    const index = buildAgentDomainIndex(state);

    const newest = Math.max(
      ...state.runs.map((r) => r.updatedAt),
      ...state.events.map((e) => e.timestamp),
      ...state.workItems.map((i) => i.updatedAt),
      ...state.artifactLinks.map((l) => l.createdAt)
    );

    const at = deriveLastActivityAt(index, runId);
    expect(at).toBeDefined();
    expect(at! <= newest).toBe(true);
    // And emphatically not the wall clock, which is years past T0.
    expect(at! < Date.now()).toBe(true);
  });

  it("is undefined for a run that does not exist", () => {
    const index = buildAgentDomainIndex(withAgent().state);
    expect(deriveLastActivityAt(index, "no-such-run")).toBeUndefined();
  });
});

describe("the run summary", () => {
  it("counts distinct files and tabs, not links", () => {
    const { state, runId } = populated();
    const summary = getAgentRunSummary(buildAgentDomainIndex(state), runId);

    expect(summary).toBeDefined();
    // Two files, though src/auth.ts carries two roles.
    expect(summary!.artifactCount).toBe(2);
    // t1 and t2 are context; t1 and t3 are produced. Counted per role.
    expect(summary!.contextTabCount).toBe(2);
    expect(summary!.producedTabCount).toBe(2);
  });

  it("copies the run's own status rather than deriving one", () => {
    const base = withAgent();
    // A run whose every work item is finished is still `working` until the
    // domain says otherwise. Inferring `completed` here is the exact
    // fabrication the phase forbids.
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
    });
    const done = withWorkItem(run.state, {
      runId: run.runId,
      title: "All done",
      status: "completed",
    });

    const summary = getAgentRunSummary(buildAgentDomainIndex(done.state), run.runId);
    expect(summary!.status).toBe("working");
    expect(summary!.progress).toEqual({ completed: 1, total: 1 });
  });

  it("is undefined for an unknown run rather than a summary of zeros", () => {
    const index = buildAgentDomainIndex(withAgent().state);
    expect(getAgentRunSummary(index, "no-such-run")).toBeUndefined();
  });

  it("reports a real run with no work at all as empty, not absent", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });
    const summary = getAgentRunSummary(buildAgentDomainIndex(run.state), run.runId);

    expect(summary).toBeDefined();
    expect(summary!.workItems.total).toBe(0);
    expect(summary!.artifactCount).toBe(0);
    expect(summary!.contextTabCount).toBe(0);
    expect(summary!.producedTabCount).toBe(0);
    expect(summary!.progress).toBeUndefined();
  });
});

describe("nothing is fabricated from absence", () => {
  it("does not mark a run complete because its work items all finished", () => {
    const base = withAgent();
    const run = withRun(base.state, {
      agentId: base.agentId,
      workspaceId: "w1",
      status: "working",
    });
    const done = withWorkItem(run.state, { runId: run.runId, title: "X", status: "completed" });

    const summary = getAgentRunSummary(buildAgentDomainIndex(done.state), run.runId);
    expect(summary!.status).not.toBe("completed");
  });

  it("does not invent progress from event volume", () => {
    const base = withAgent();
    const run = withRun(base.state, { agentId: base.agentId, workspaceId: "w1" });

    // Plenty of observed activity, and no work items at all. A layer that
    // inferred progress from how much happened would report something here.
    let state: AgentState = run.state;
    for (let i = 0; i < 25; i += 1) {
      state = withEvent(state, { runId: run.runId, summary: `Edited file-${i}.ts` }, T0 + i);
    }

    const summary = getAgentRunSummary(buildAgentDomainIndex(state), run.runId);
    expect(summary!.progress).toBeUndefined();
    expect(summary!.workItems.total).toBe(0);
  });
});
