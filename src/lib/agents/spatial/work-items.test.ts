import { describe, expect, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { createWorkItem, transitionWorkItem } from "@/lib/agents/work-items";
import { buildInspectorSelection } from "./inspector";
import { placeAgentScene, placementsAgree } from "./placement";
import { buildAgentSpatialScene, runIdForWorkItemSelection } from "./scene";
import { searchAgentScene, searchAgentWork } from "./search";
import { runSpatialId, workItemIdFromSpatialId, workItemSpatialId } from "./types";
import type { AgentState, AgentWorkItemStatus } from "@/lib/agents/types";
import type { AgentSpatialFilter, AgentSpatialScene } from "./types";

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";

function seed(workspaceId = "wA") {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(
    agent.state,
    { agentId: agent.agent.id, workspaceId, title: "Implement auth" },
    T0
  );
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, agentId: agent.agent.id, runId: run.run.id };
}

function addRun(state: AgentState, agentId: string, workspaceId: string, title: string) {
  const run = createRun(state, { agentId, workspaceId, title }, T0);
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, runId: run.run.id };
}

function withItem(
  state: AgentState,
  runId: string,
  title: string,
  over: { summary?: string; status?: AgentWorkItemStatus; createdAt?: number } = {}
) {
  const created = createWorkItem(
    state,
    { runId, title, summary: over.summary },
    over.createdAt ?? T0
  );
  if (!created.ok) throw new Error("fixture failed");

  let next = created.state;
  // Reached through the real lifecycle, so no test ever asserts against a
  // state the domain would refuse to produce.
  if (over.status && over.status !== "pending") {
    const path: AgentWorkItemStatus[] =
      over.status === "active"
        ? ["active"]
        : over.status === "completed"
          ? ["active", "completed"]
          : over.status === "blocked"
            ? ["active", "blocked"]
            : ["cancelled"];

    for (const status of path) {
      const moved = transitionWorkItem(next, created.workItem.id, status, T0 + 10);
      if (!moved.ok) throw new Error(`fixture failed: ${status}`);
      next = moved.state;
    }
  }

  return { state: next, itemId: created.workItem.id };
}

function build(
  state: AgentState,
  over: Partial<{
    workspaceId: string;
    filter: AgentSpatialFilter;
    selectedId: string | null;
    now: number;
  }> = {}
): AgentSpatialScene {
  return buildAgentSpatialScene(state, {
    agents: state.agents,
    runs: state.runs,
    artifacts: state.artifacts,
    workspaceId: over.workspaceId ?? "wA",
    filter: over.filter ?? "active",
    selectedId: over.selectedId ?? null,
    now: over.now ?? T0 + 1000,
  });
}

function runNode(scene: AgentSpatialScene, runId: string) {
  const node = scene.nodes.find((n) => n.kind === "run" && n.runId === runId);
  if (!node || node.kind !== "run") throw new Error("no run node");
  return node;
}

describe("work items on the scene", () => {
  it("carries a run's work items, oldest first", () => {
    const { state, runId } = seed();
    const a = withItem(state, runId, "First", { createdAt: T0 });
    const b = withItem(a.state, runId, "Second", { createdAt: T0 + 5 });

    const scene = build(b.state);
    expect(scene.workItems.map((i) => i.title)).toEqual(["First", "Second"]);
  });

  it("never puts a work item in scene.nodes", () => {
    const { state, runId } = seed();
    const { state: withOne } = withItem(state, runId, "Task");

    const scene = build(withOne);
    expect(scene.workItems).toHaveLength(1);
    // The structural guarantee: everything that is placed, drawn or
    // hit-tested lives in `nodes`, and no work item is ever in it.
    for (const node of scene.nodes) {
      expect(["agent", "run", "artifact"]).toContain(node.kind);
      expect(node.id.startsWith("workitem:")).toBe(false);
    }
  });

  it("counts work items on the owning run node", () => {
    const { state, runId } = seed();
    const a = withItem(state, runId, "One");
    const b = withItem(a.state, runId, "Two");

    expect(runNode(build(b.state), runId).workItemCount).toBe(2);
  });

  it("omits progress entirely for a run with no work items", () => {
    const { state, runId } = seed();
    const node = runNode(build(state), runId);

    expect(node.workItemCount).toBe(0);
    expect(node.workProgress).toBeUndefined();
    expect(node.primaryWorkItemTitle).toBeUndefined();
  });

  it("derives progress from real statuses", () => {
    const { state, runId } = seed();
    const a = withItem(state, runId, "Done", { status: "completed" });
    const b = withItem(a.state, runId, "Not done");

    expect(runNode(build(b.state), runId).workProgress).toEqual({ completed: 1, total: 2 });
  });

  it("surfaces the active item as the run's primary work", () => {
    const { state, runId } = seed();
    const a = withItem(state, runId, "First", { createdAt: T0 });
    const b = withItem(a.state, runId, "Second", { createdAt: T0 + 5, status: "active" });

    expect(runNode(build(b.state), runId).primaryWorkItemTitle).toBe("Second");
  });

  it("inherits visibility from the owning run", () => {
    const { state, runId, agentId } = seed();
    const live = withItem(state, runId, "Live work");

    const second = addRun(live.state, agentId, "wA", "Old run");
    const old = withItem(second.state, second.runId, "Old work");
    // Finished long enough ago to fall outside the default window.
    const finished = transitionRunStatus(
      old.state,
      second.runId,
      "completed",
      T0 - 10 * 60 * 60 * 1000
    );
    if (!finished.ok) throw new Error("fixture failed");

    const scene = build(finished.state, { filter: "active", now: T0 + 1000 });
    expect(scene.workItems.map((i) => i.title)).toEqual(["Live work"]);

    // Under "all", the hidden run's work comes back with it.
    const everything = build(finished.state, { filter: "all", now: T0 + 1000 });
    expect(everything.workItems.map((i) => i.title).sort()).toEqual(["Live work", "Old work"]);
  });
});

describe("workspace isolation on the scene", () => {
  it("shows only the selected workspace's work items", () => {
    const { state, runId, agentId } = seed("w1");
    const a = withItem(state, runId, "Workspace one work");

    const second = addRun(a.state, agentId, "w2", "Other run");
    const b = withItem(second.state, second.runId, "Workspace two work");

    expect(build(b.state, { workspaceId: "w1" }).workItems.map((i) => i.title)).toEqual([
      "Workspace one work",
    ]);
    expect(build(b.state, { workspaceId: "w2" }).workItems.map((i) => i.title)).toEqual([
      "Workspace two work",
    ]);
    expect(build(b.state, { workspaceId: "w3" }).workItems).toEqual([]);
  });

  it("produces no work items for an empty workspace, without crashing", () => {
    expect(build(emptyAgentState()).workItems).toEqual([]);
    expect(build(emptyAgentState(), { workspaceId: "" }).workItems).toEqual([]);
  });
});

describe("spatial stability", () => {
  /** Positions for a scene, as the canvas would compute them. */
  function place(scene: AgentSpatialScene, tabBounds = { minX: 0, maxX: 500, minY: 0, maxY: 400 }) {
    return placeAgentScene({ scene, pinned: {}, tabBounds });
  }

  it("adding a work item moves nothing that was already placed", () => {
    const { state, runId, agentId } = seed();
    const second = addRun(state, agentId, "wA", "Another run");
    const before = place(build(second.state));

    const { state: withOne } = withItem(second.state, runId, "New task");
    const after = place(build(withOne));

    expect(placementsAgree(before, after)).toBe(true);
    // And nothing new was placed either — a work item has no position at all.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it("completing a work item moves nothing", () => {
    const { state, runId } = seed();
    const a = withItem(state, runId, "Task", { status: "active" });
    const before = place(build(a.state));

    const done = transitionWorkItem(a.state, a.itemId, "completed", T0 + 100);
    if (!done.ok) throw new Error("fixture failed");

    expect(placementsAgree(before, place(build(done.state)))).toBe(true);
  });

  it("stays stable across many work items on many runs", () => {
    const { state, runId, agentId } = seed();
    let next = state;
    const runIds = [runId];
    for (let i = 0; i < 12; i += 1) {
      const added = addRun(next, agentId, "wA", `Run ${i}`);
      next = added.state;
      runIds.push(added.runId);
    }

    const before = place(build(next));

    for (const id of runIds) {
      for (let i = 0; i < 8; i += 1) {
        next = withItem(next, id, `Task ${i}`).state;
      }
    }

    const after = place(build(next));
    expect(placementsAgree(before, after)).toBe(true);
    expect(after.size).toBe(before.size);
  });

  it("placement is a pure function of identity, repeated calls agreeing exactly", () => {
    const { state, runId } = seed();
    const { state: withOne } = withItem(state, runId, "Task");
    const scene = build(withOne);

    expect([...place(scene).entries()]).toEqual([...place(scene).entries()]);
  });

  it("artifact placement is unaffected by work items", () => {
    const { state, runId } = seed();
    const withFile = recordArtifactWork(
      state,
      { runId, projectPath: PROJECT, path: "src/a.ts", role: "edited" },
      T0
    );
    if (!withFile.ok) throw new Error("fixture failed");

    const before = place(build(withFile.state, { selectedId: runSpatialId(runId) }));
    const { state: withOne } = withItem(withFile.state, runId, "Task");
    const after = place(build(withOne, { selectedId: runSpatialId(runId) }));

    expect(placementsAgree(before, after)).toBe(true);
  });
});

describe("selecting a work item", () => {
  it("resolves to its owning run for focus", () => {
    const { state, runId } = seed();
    const { state: withOne, itemId } = withItem(state, runId, "Task");
    const scene = build(withOne);

    expect(runIdForWorkItemSelection(scene, workItemSpatialId(itemId))).toBe(runSpatialId(runId));
  });

  it("resolves to null for a non-work-item selection", () => {
    const { state, runId } = seed();
    const scene = build(state);
    expect(runIdForWorkItemSelection(scene, runSpatialId(runId))).toBeNull();
    expect(runIdForWorkItemSelection(scene, null)).toBeNull();
  });

  it("resolves to null for an item the scene does not hold", () => {
    const { state } = seed();
    expect(runIdForWorkItemSelection(build(state), workItemSpatialId("ghost"))).toBeNull();
  });

  it("round-trips a spatial id back to its domain id", () => {
    expect(workItemIdFromSpatialId(workItemSpatialId("abc"))).toBe("abc");
    expect(workItemIdFromSpatialId("run:abc")).toBeNull();
    expect(workItemIdFromSpatialId(null)).toBeNull();
  });
});

describe("the work item inspector", () => {
  const tabTitles = new Map<string, string>();

  it("shows the item, its run and its agent", () => {
    const { state, runId } = seed();
    const { state: withOne, itemId } = withItem(withItem(state, runId, "Other").state, runId, "Implement authentication", {
      summary: "Sign-in route and tests",
      status: "active",
    });
    const scene = build(withOne);

    const selection = buildInspectorSelection({
      state: withOne,
      scene,
      selectedId: workItemSpatialId(itemId),
      tabTitles,
    });

    expect(selection?.kind).toBe("workItem");
    if (selection?.kind !== "workItem") return;
    expect(selection.item.title).toBe("Implement authentication");
    expect(selection.item.summary).toBe("Sign-in route and tests");
    expect(selection.item.status).toBe("active");
    expect(selection.runTitle).toBe("Implement auth");
    expect(selection.agentName).toBe("Claude Code");
    expect(selection.runSpatialId).toBe(runSpatialId(runId));
  });

  it("carries the run's files so the item's context is visible", () => {
    const { state, runId } = seed();
    const withFile = recordArtifactWork(
      state,
      { runId, projectPath: PROJECT, path: "src/auth.ts", role: "edited" },
      T0
    );
    if (!withFile.ok) throw new Error("fixture failed");
    const { state: withOne, itemId } = withItem(withFile.state, runId, "Task");

    const selection = buildInspectorSelection({
      state: withOne,
      scene: build(withOne),
      selectedId: workItemSpatialId(itemId),
      tabTitles,
    });

    if (selection?.kind !== "workItem") throw new Error("expected a work item");
    expect(selection.files.map((f) => f.relativePath)).toEqual(["src/auth.ts"]);
    // Project-relative, never the absolute root it came from.
    expect(JSON.stringify(selection)).not.toContain("C:\\");
  });

  it("lists a run's work items on the run selection", () => {
    const { state, runId } = seed();
    const a = withItem(state, runId, "First", { createdAt: T0 });
    const b = withItem(a.state, runId, "Second", { createdAt: T0 + 5 });

    const selection = buildInspectorSelection({
      state: b.state,
      scene: build(b.state),
      selectedId: runSpatialId(runId),
      tabTitles,
    });

    if (selection?.kind !== "run") throw new Error("expected a run");
    expect(selection.workItems.map((i) => i.title)).toEqual(["First", "Second"]);
  });

  it("returns null rather than throwing for an item that is gone", () => {
    const { state, runId } = seed();
    const { state: withOne } = withItem(state, runId, "Task");

    expect(
      buildInspectorSelection({
        state: withOne,
        scene: build(withOne),
        selectedId: workItemSpatialId("deleted-id"),
        tabTitles,
      })
    ).toBeNull();
  });

  it("tolerates a work item whose run has been deleted", () => {
    const { state, runId } = seed();
    const { state: withOne, itemId } = withItem(state, runId, "Task");
    const scene = build(withOne);

    // The run vanishes from state after the scene was built — a deletion
    // racing a render, which must degrade rather than crash.
    const orphaned: AgentState = { ...withOne, runs: [] };
    const selection = buildInspectorSelection({
      state: orphaned,
      scene,
      selectedId: workItemSpatialId(itemId),
      tabTitles,
    });

    if (selection?.kind !== "workItem") throw new Error("expected a work item");
    expect(selection.runTitle).toBe("Untitled run");
    expect(selection.agentName).toBe("Agent");
    expect(selection.files).toEqual([]);
    expect(selection.events).toEqual([]);
  });
});

describe("searching work items", () => {
  function scened() {
    const { state, runId } = seed();
    const a = withItem(state, runId, "Implement authentication", {
      summary: "Sign-in route and tests",
    });
    const b = withItem(a.state, runId, "Investigate failing graph test", { status: "blocked" });
    return { state: b.state, runId, itemId: a.itemId };
  }

  it("finds an item by its title", () => {
    const { state } = scened();
    const results = searchAgentScene(build(state), "authentication");

    const workItems = results.filter((r) => r.kind === "workItem");
    expect(workItems.map((r) => r.label)).toEqual(["Implement authentication"]);
    expect(workItems[0].typeLabel).toBe("Work item");
  });

  it("finds an item by its summary", () => {
    const { state } = scened();
    const results = searchAgentScene(build(state), "sign-in route");
    expect(results.some((r) => r.kind === "workItem")).toBe(true);
  });

  it("finds items by status, in the words the UI shows", () => {
    const { state } = scened();
    const results = searchAgentScene(build(state), "blocked");
    expect(results.some((r) => r.label === "Investigate failing graph test")).toBe(true);
  });

  it("ranks work items above runs", () => {
    const { state } = scened();
    // "implement" matches both the run title ("Implement auth") and an item.
    const results = searchAgentScene(build(state), "implement");
    expect(results[0].kind).toBe("workItem");
  });

  it("carries the item's own spatial id, so selecting it selects the item", () => {
    const { state, itemId } = scened();
    const results = searchAgentScene(build(state), "authentication");
    expect(results[0].id).toBe(workItemSpatialId(itemId));
  });

  it("never surfaces an identifier", () => {
    const { state, runId, itemId } = scened();
    const scene = build(state);

    // Searching for an id finds nothing, and no result echoes one.
    for (const id of [itemId, runId]) {
      expect(searchAgentScene(scene, id)).toEqual([]);
    }
    for (const result of searchAgentScene(scene, "implement")) {
      expect(result.label).not.toContain(itemId);
      expect(result.detail ?? "").not.toContain(itemId);
    }
  });

  it("respects the workspace boundary", () => {
    const { state, runId, agentId } = seed("w1");
    const a = withItem(state, runId, "Secret workspace one task");
    const second = addRun(a.state, agentId, "w2", "Other");
    const b = withItem(second.state, second.runId, "Workspace two task");

    expect(searchAgentScene(build(b.state, { workspaceId: "w2" }), "secret")).toEqual([]);
    expect(
      searchAgentScene(build(b.state, { workspaceId: "w1" }), "secret").map((r) => r.label)
    ).toEqual(["Secret workspace one task"]);
  });

  it("respects the active filter, via the scene", () => {
    const { state, runId, agentId } = seed();
    const second = addRun(state, agentId, "wA", "Old run");
    const old = withItem(second.state, second.runId, "Ancient task");
    const finished = transitionRunStatus(
      old.state,
      second.runId,
      "completed",
      T0 - 10 * 60 * 60 * 1000
    );
    if (!finished.ok) throw new Error("fixture failed");

    expect(searchAgentScene(build(finished.state, { filter: "active" }), "ancient")).toEqual([]);
    expect(searchAgentScene(build(finished.state, { filter: "all" }), "ancient")).toHaveLength(1);
    expect(runId).toBeDefined();
  });

  it("includes work items in the combined search entry point", () => {
    const { state } = scened();
    const results = searchAgentWork(
      build(state),
      { artifacts: [], artifactLinks: [], workspaceId: "wA", visibleRunIds: new Set() },
      "authentication"
    );

    expect(results.some((r) => r.kind === "workItem")).toBe(true);
  });
});
