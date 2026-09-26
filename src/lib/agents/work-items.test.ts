import { describe, expect, it } from "vitest";
import { createAgent, deleteAgentAndRuns } from "./registry";
import { createRun, deleteRun } from "./runs";
import {
  getPrimaryWorkItem,
  getRunWorkProgress,
  getWorkItemsByStatus,
  getWorkItemsForRun,
  getWorkspaceWorkItemCounts,
  getWorkspaceWorkItems,
} from "./selectors";
import { MAX_WORK_ITEMS_PER_RUN, emptyAgentState } from "./types";
import {
  canTransitionWorkItem,
  createWorkItem,
  deleteWorkItem,
  findWorkItem,
  findWorkItemByExternalId,
  removeWorkItemsForRun,
  transitionWorkItem,
  updateWorkItem,
} from "./work-items";
import type { AgentState, AgentWorkItemStatus } from "./types";

const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;
const T2 = T0 + 120_000;

/** An agent with one run in `wA`. */
function seeded(workspaceId = "wA") {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "N" }, T0);
  if (!agent.ok) throw new Error("fixture failed");

  const run = createRun(agent.state, { agentId: agent.agent.id, workspaceId }, T0);
  if (!run.ok) throw new Error("fixture failed");

  return { state: run.state, runId: run.run.id, agentId: agent.agent.id };
}

function addRun(state: AgentState, agentId: string, workspaceId: string) {
  const run = createRun(state, { agentId, workspaceId }, T0);
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, runId: run.run.id };
}

function withItem(
  state: AgentState,
  runId: string,
  title = "Implement authentication",
  now = T0
) {
  const created = createWorkItem(state, { runId, title }, now);
  if (!created.ok) throw new Error("fixture failed");
  return { state: created.state, itemId: created.workItem.id };
}

/** Walks an item to `status` through the legal path, for tests that need it there. */
function drive(
  state: AgentState,
  itemId: string,
  path: AgentWorkItemStatus[],
  now = T1
): AgentState {
  let next = state;
  for (const status of path) {
    const moved = transitionWorkItem(next, itemId, status, now);
    if (!moved.ok) throw new Error(`fixture failed: cannot reach ${status}`);
    next = moved.state;
  }
  return next;
}

describe("creating work items", () => {
  it("takes its workspace from the run rather than the caller", () => {
    const { state, runId } = seeded("wA");
    const created = createWorkItem(state, { runId, title: "Do the thing" }, T0);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // There is no input field for a workspace at all — this is the structural
    // guarantee that a work item cannot land outside its run's workspace.
    expect(created.workItem.workspaceId).toBe("wA");
    expect(created.workItem.runId).toBe(runId);
  });

  it("refuses a run that does not exist", () => {
    const created = createWorkItem(emptyAgentState(), { runId: "nope", title: "x" }, T0);
    expect(created).toEqual({ ok: false, reason: "run-not-found" });
  });

  it("refuses a title that is empty or only whitespace", () => {
    const { state, runId } = seeded();
    expect(createWorkItem(state, { runId, title: "   " }, T0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("normalises a title: collapsed whitespace, trimmed", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(state, { runId, title: "  Fix \n\n the   bug  " }, T0);
    if (!created.ok) throw new Error("expected success");
    expect(created.workItem.title).toBe("Fix the bug");
  });

  it("defaults to pending, with no start and no completion", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(state, { runId, title: "x" }, T0);
    if (!created.ok) throw new Error("expected success");

    expect(created.workItem.status).toBe("pending");
    expect(created.workItem.startedAt).toBeUndefined();
    expect(created.workItem.completedAt).toBeUndefined();
    expect(created.workItem.createdAt).toBe(T0);
    expect(created.workItem.updatedAt).toBe(T0);
  });

  it("stamps startedAt when created already active", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(state, { runId, title: "x", status: "active" }, T0);
    if (!created.ok) throw new Error("expected success");
    expect(created.workItem.startedAt).toBe(T0);
    expect(created.workItem.completedAt).toBeUndefined();
  });

  it("claims no start for an item discovered already finished", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(state, { runId, title: "x", status: "completed" }, T0);
    if (!created.ok) throw new Error("expected success");

    expect(created.workItem.completedAt).toBe(T0);
    // It plainly started at some point, but nothing observed when — so the
    // record says nothing rather than asserting the moment Hubble looked.
    expect(created.workItem.startedAt).toBeUndefined();
  });

  it("drops progress that does not describe a real ratio", () => {
    const { state, runId } = seeded();
    for (const progress of [
      { completed: 3, total: 0 },
      { completed: 5, total: 2 },
      { completed: -1, total: 4 },
      { completed: 1.5, total: 4 },
    ]) {
      const created = createWorkItem(state, { runId, title: "x", progress }, T0);
      if (!created.ok) throw new Error("expected success");
      expect(created.workItem.progress).toBeUndefined();
    }
  });

  it("keeps progress that does", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(
      state,
      { runId, title: "x", progress: { completed: 2, total: 5 } },
      T0
    );
    if (!created.ok) throw new Error("expected success");
    expect(created.workItem.progress).toEqual({ completed: 2, total: 5 });
  });

  it("bounds how many items one run may hold", () => {
    const { state, runId } = seeded();
    let next = state;
    for (let i = 0; i < MAX_WORK_ITEMS_PER_RUN; i += 1) {
      const created = createWorkItem(next, { runId, title: `task ${i}` }, T0);
      if (!created.ok) throw new Error("expected success");
      next = created.state;
    }

    expect(createWorkItem(next, { runId, title: "one too many" }, T0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(getWorkItemsForRun(next, runId)).toHaveLength(MAX_WORK_ITEMS_PER_RUN);
  });

  it("finds an item by its provider id, scoped to the run", () => {
    const { state, runId, agentId } = seeded();
    const first = createWorkItem(state, { runId, title: "A", externalId: "1" }, T0);
    if (!first.ok) throw new Error("expected success");

    const second = addRun(first.state, agentId, "wA");
    const other = createWorkItem(second.state, { runId: second.runId, title: "B", externalId: "1" }, T0);
    if (!other.ok) throw new Error("expected success");

    // The same provider id in two runs is two different items — provider task
    // ids are session-scoped integers and collide constantly.
    expect(findWorkItemByExternalId(other.state, runId, "1")?.title).toBe("A");
    expect(findWorkItemByExternalId(other.state, second.runId, "1")?.title).toBe("B");
  });
});

describe("the lifecycle", () => {
  const legal: [AgentWorkItemStatus, AgentWorkItemStatus][] = [
    ["pending", "active"],
    ["pending", "cancelled"],
    ["active", "blocked"],
    ["active", "completed"],
    ["active", "cancelled"],
    ["blocked", "active"],
    ["blocked", "cancelled"],
  ];

  const illegal: [AgentWorkItemStatus, AgentWorkItemStatus][] = [
    // Work cannot finish without having been worked on.
    ["pending", "completed"],
    ["pending", "blocked"],
    ["blocked", "completed"],
    // Terminal means terminal — there is no reopening.
    ["completed", "active"],
    ["completed", "pending"],
    ["completed", "cancelled"],
    ["cancelled", "active"],
    ["cancelled", "completed"],
  ];

  it.each(legal)("allows %s -> %s", (from, to) => {
    expect(canTransitionWorkItem(from, to)).toBe(true);
  });

  it.each(illegal)("refuses %s -> %s", (from, to) => {
    expect(canTransitionWorkItem(from, to)).toBe(false);
  });

  it("blocked is not terminal, unlike a blocked run", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);

    const blocked = drive(withOne, itemId, ["active", "blocked"]);
    const unblocked = transitionWorkItem(blocked, itemId, "active", T2);

    expect(unblocked.ok).toBe(true);
    if (!unblocked.ok) return;
    expect(unblocked.workItem.status).toBe("active");
  });

  it("rejects an illegal transition and leaves state untouched", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);

    const refused = transitionWorkItem(withOne, itemId, "completed", T1);
    expect(refused).toEqual({ ok: false, reason: "invalid-transition" });
    expect(findWorkItem(withOne, itemId)?.status).toBe("pending");
  });

  it("reports a missing item rather than inventing one", () => {
    expect(transitionWorkItem(emptyAgentState(), "nope", "active", T1)).toEqual({
      ok: false,
      reason: "work-item-not-found",
    });
  });
});

describe("lifecycle timestamps", () => {
  it("stamps startedAt on the first move to active", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);

    const active = transitionWorkItem(withOne, itemId, "active", T1);
    if (!active.ok) throw new Error("expected success");

    expect(active.workItem.startedAt).toBe(T1);
    expect(active.workItem.updatedAt).toBe(T1);
    expect(active.workItem.createdAt).toBe(T0);
  });

  it("does not rewrite startedAt when an item is unblocked", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);

    const blocked = drive(withOne, itemId, ["active", "blocked"], T1);
    const again = transitionWorkItem(blocked, itemId, "active", T2);
    if (!again.ok) throw new Error("expected success");

    // The item first started at T1; the second transition is not a new start.
    expect(again.workItem.startedAt).toBe(T1);
  });

  it("stamps completedAt on completion and on cancellation alike", () => {
    for (const terminal of ["completed", "cancelled"] as const) {
      const { state, runId } = seeded();
      const { state: withOne, itemId } = withItem(state, runId);

      const done = drive(withOne, itemId, ["active", terminal], T2);
      expect(findWorkItem(done, itemId)?.completedAt).toBe(T2);
    }
  });

  it("treats re-asserting a live status as a no-op that changes nothing", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);
    const active = drive(withOne, itemId, ["active"], T1);

    const again = transitionWorkItem(active, itemId, "active", T2);
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    // Identity, not just equality: a poll reporting "still active" must not
    // produce a new state object and retrigger every consumer downstream.
    expect(again.state).toBe(active);
    expect(again.workItem.updatedAt).toBe(T1);
  });

  it("refuses re-asserting a terminal status, so the caller can tell it is over", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);
    const done = drive(withOne, itemId, ["active", "completed"], T1);

    expect(transitionWorkItem(done, itemId, "completed", T2)).toEqual({
      ok: false,
      reason: "invalid-transition",
    });
  });
});

describe("updating metadata", () => {
  it("leaves absent fields alone — no news is not erasure", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(
      state,
      { runId, title: "Original", summary: "Some detail" },
      T0
    );
    if (!created.ok) throw new Error("expected success");

    const patched = updateWorkItem(created.state, created.workItem.id, {}, T1);
    if (!patched.ok) throw new Error("expected success");

    expect(patched.workItem.title).toBe("Original");
    expect(patched.workItem.summary).toBe("Some detail");
    expect(patched.state).toBe(created.state);
  });

  it("refuses to clear a title, but allows clearing a summary", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(state, { runId, title: "Original", summary: "detail" }, T0);
    if (!created.ok) throw new Error("expected success");

    const patched = updateWorkItem(
      created.state,
      created.workItem.id,
      { title: "  ", summary: "" },
      T1
    );
    if (!patched.ok) throw new Error("expected success");

    expect(patched.workItem.title).toBe("Original");
    expect(patched.workItem.summary).toBeUndefined();
  });

  it("clears progress only when asked explicitly with null", () => {
    const { state, runId } = seeded();
    const created = createWorkItem(
      state,
      { runId, title: "x", progress: { completed: 1, total: 3 } },
      T0
    );
    if (!created.ok) throw new Error("expected success");

    const noNews = updateWorkItem(created.state, created.workItem.id, {}, T1);
    if (!noNews.ok) throw new Error("expected success");
    expect(noNews.workItem.progress).toEqual({ completed: 1, total: 3 });

    const cleared = updateWorkItem(created.state, created.workItem.id, { progress: null }, T1);
    if (!cleared.ok) throw new Error("expected success");
    expect(cleared.workItem.progress).toBeUndefined();
  });

  it("offers no way to change status, run or workspace", () => {
    const { state, runId } = seeded();
    const { state: withOne, itemId } = withItem(state, runId);

    // Not a type-level assertion but a behavioural one: passing them through
    // an untyped patch must not move the item.
    const patched = updateWorkItem(
      withOne,
      itemId,
      { status: "completed", runId: "other", workspaceId: "wB" } as never,
      T1
    );
    if (!patched.ok) throw new Error("expected success");

    expect(patched.workItem.status).toBe("pending");
    expect(patched.workItem.runId).toBe(runId);
    expect(patched.workItem.workspaceId).toBe("wA");
  });

  it("reports a missing item", () => {
    expect(updateWorkItem(emptyAgentState(), "nope", { title: "x" }, T1)).toEqual({
      ok: false,
      reason: "work-item-not-found",
    });
  });
});

describe("deletion and cascade", () => {
  it("deletes one item without touching its run's other work", () => {
    const { state, runId } = seeded();
    const first = withItem(state, runId, "A");
    const second = withItem(first.state, runId, "B");

    const deleted = deleteWorkItem(second.state, first.itemId);
    if (!deleted.ok) throw new Error("expected success");

    expect(findWorkItem(deleted.state, first.itemId)).toBeUndefined();
    expect(findWorkItem(deleted.state, second.itemId)?.title).toBe("B");
  });

  it("reports deleting something that is not there", () => {
    expect(deleteWorkItem(emptyAgentState(), "nope")).toEqual({
      ok: false,
      reason: "work-item-not-found",
    });
  });

  it("takes a run's work items with the run", () => {
    const { state, runId, agentId } = seeded();
    const mine = withItem(state, runId, "Mine");
    const other = addRun(mine.state, agentId, "wA");
    const theirs = withItem(other.state, other.runId, "Theirs");

    const deleted = deleteRun(theirs.state, runId);
    if (!deleted.ok) throw new Error("expected success");

    expect(findWorkItem(deleted.state, mine.itemId)).toBeUndefined();
    // The other run's work is untouched — no dangling references either way.
    expect(findWorkItem(deleted.state, theirs.itemId)?.title).toBe("Theirs");
  });

  it("takes every run's work items when the agent goes", () => {
    const { state, runId, agentId } = seeded();
    const first = withItem(state, runId, "A");
    const second = addRun(first.state, agentId, "wB");
    const sibling = withItem(second.state, second.runId, "B");

    const deleted = deleteAgentAndRuns(sibling.state, agentId);
    if (!deleted.ok) throw new Error("expected success");

    expect(deleted.state.workItems).toEqual([]);
  });

  it("removeWorkItemsForRun keeps the same object when nothing matches", () => {
    const { state, runId } = seeded();
    const { state: withOne } = withItem(state, runId);
    expect(removeWorkItemsForRun(withOne, "no-such-run")).toBe(withOne);
  });
});

describe("workspace and account isolation", () => {
  /**
   * The matrix the phase brief calls for: one agent working in two
   * workspaces, plus a third run standing in for a second account's state
   * (accounts are separated by the storage namespace, so within one loaded
   * state the boundary that must hold is the workspace one).
   */
  function matrix() {
    const { state, runId: runA, agentId } = seeded("w1");
    const a = withItem(state, runA, "Work A");

    const second = addRun(a.state, agentId, "w2");
    const b = withItem(second.state, second.runId, "Work B");

    return { state: b.state, runA, runB: second.runId, itemA: a.itemId, itemB: b.itemId };
  }

  it("scopes a workspace's work items to that workspace", () => {
    const { state } = matrix();

    expect(getWorkspaceWorkItems(state, "w1").map((i) => i.title)).toEqual(["Work A"]);
    expect(getWorkspaceWorkItems(state, "w2").map((i) => i.title)).toEqual(["Work B"]);
    expect(getWorkspaceWorkItems(state, "w3")).toEqual([]);
  });

  it("scopes items to their run", () => {
    const { state, runA, runB } = matrix();

    expect(getWorkItemsForRun(state, runA).map((i) => i.title)).toEqual(["Work A"]);
    expect(getWorkItemsForRun(state, runB).map((i) => i.title)).toEqual(["Work B"]);
  });

  it("never lets an item carry a workspace its run does not have", () => {
    const { state } = matrix();
    for (const item of state.workItems) {
      const run = state.runs.find((r) => r.id === item.runId);
      expect(item.workspaceId).toBe(run?.workspaceId);
    }
  });

  it("counts per workspace without borrowing from another", () => {
    const { state, itemA } = matrix();
    const active = drive(state, itemA, ["active"], T1);

    expect(getWorkspaceWorkItemCounts(active, "w1")).toEqual({
      total: 1,
      active: 1,
      blocked: 0,
      completed: 0,
    });
    expect(getWorkspaceWorkItemCounts(active, "w2")).toEqual({
      total: 1,
      active: 0,
      blocked: 0,
      completed: 0,
    });
  });

  it("filters by status within one workspace only", () => {
    const { state, itemA } = matrix();
    const active = drive(state, itemA, ["active"], T1);

    expect(getWorkItemsByStatus(active, "w1", "active").map((i) => i.title)).toEqual(["Work A"]);
    expect(getWorkItemsByStatus(active, "w2", "active")).toEqual([]);
  });
});

describe("derived progress", () => {
  it("is undefined for a run with no work items", () => {
    const { state, runId } = seeded();
    expect(getRunWorkProgress(state, runId)).toBeUndefined();
  });

  it("counts real statuses, never events or elapsed time", () => {
    const { state, runId } = seeded();
    const a = withItem(state, runId, "A");
    const b = withItem(a.state, runId, "B");
    const c = withItem(b.state, runId, "C");

    const done = drive(c.state, a.itemId, ["active", "completed"], T1);
    expect(getRunWorkProgress(done, runId)).toEqual({ completed: 1, total: 3 });
  });

  it("excludes cancelled work from both sides of the ratio", () => {
    const { state, runId } = seeded();
    const a = withItem(state, runId, "A");
    const b = withItem(a.state, runId, "B");

    let next = drive(b.state, a.itemId, ["active", "completed"], T1);
    next = drive(next, b.itemId, ["cancelled"], T1);

    // One item finished, one abandoned: the plan is done, not half done.
    expect(getRunWorkProgress(next, runId)).toEqual({ completed: 1, total: 1 });
  });

  it("is undefined when every item was cancelled", () => {
    const { state, runId } = seeded();
    const a = withItem(state, runId, "A");
    const next = drive(a.state, a.itemId, ["cancelled"], T1);
    expect(getRunWorkProgress(next, runId)).toBeUndefined();
  });
});

describe("the primary work item", () => {
  it("is undefined when a run has no work", () => {
    const { state, runId } = seeded();
    expect(getPrimaryWorkItem(state, runId)).toBeUndefined();
  });

  it("prefers active work over everything else", () => {
    const { state, runId } = seeded();
    const a = withItem(state, runId, "First", T0);
    const b = withItem(a.state, runId, "Second", T0 + 1);

    const next = drive(b.state, b.itemId, ["active"], T1);
    expect(getPrimaryWorkItem(next, runId)?.title).toBe("Second");
  });

  it("falls back through blocked, then pending, then finished", () => {
    const { state, runId } = seeded();
    const a = withItem(state, runId, "Blocked one", T0);
    const b = withItem(a.state, runId, "Pending one", T0 + 1);

    const next = drive(b.state, a.itemId, ["active", "blocked"], T1);
    expect(getPrimaryWorkItem(next, runId)?.title).toBe("Blocked one");
    expect(findWorkItem(next, b.itemId)?.status).toBe("pending");
  });

  it("breaks ties by plan order, not by id", () => {
    const { state, runId } = seeded();
    const a = withItem(state, runId, "First", T0);
    const b = withItem(a.state, runId, "Second", T0 + 1);

    let next = drive(b.state, a.itemId, ["active"], T1);
    next = drive(next, b.itemId, ["active"], T1);

    expect(getPrimaryWorkItem(next, runId)?.title).toBe("First");
  });
});
