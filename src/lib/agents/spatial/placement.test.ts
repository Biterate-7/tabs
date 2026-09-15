import { describe, expect, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus, updateRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { MAX_GRAPH_COORD } from "@/lib/graph/types";
import { placeAgentScene, placementsAgree } from "./placement";
import { buildAgentSpatialScene } from "./scene";
import { agentSpatialId, runSpatialId } from "./types";
import type { AgentState } from "@/lib/agents/types";
import type { AgentSpatialScene, SpatialId } from "./types";

/**
 * Stability is the property this whole module exists for: a polling UI that
 * rearranges itself is worse than no UI, and a user's hand-arranged tabs must
 * never move because an agent appeared.
 */

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";
const TAB_BOUNDS = { minX: -400, maxX: 400, minY: -300, maxY: 300 };

function seed(runCount = 1) {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");

  let state: AgentState = agent.state;
  const runIds: string[] = [];
  for (let i = 0; i < runCount; i += 1) {
    const run = createRun(state, { agentId: agent.agent.id, workspaceId: "wA", title: `Run ${i}` }, T0);
    if (!run.ok) throw new Error("fixture failed");
    state = run.state;
    runIds.push(run.run.id);
  }

  return { state, agentId: agent.agent.id, runIds };
}

function scene(state: AgentState, selectedId: SpatialId | null = null): AgentSpatialScene {
  return buildAgentSpatialScene(state, {
    agents: state.agents,
    runs: state.runs,
    artifacts: state.artifacts,
    workspaceId: "wA",
    filter: "all",
    selectedId,
    now: T0 + 1000,
  });
}

function place(state: AgentState, pinned: Record<SpatialId, { x: number; y: number }> = {}, selectedId: SpatialId | null = null) {
  return placeAgentScene({ scene: scene(state, selectedId), pinned, tabBounds: TAB_BOUNDS });
}

describe("determinism", () => {
  it("places the same scene identically every time", () => {
    const { state } = seed(3);

    expect([...place(state).entries()]).toEqual([...place(state).entries()]);
  });

  it("gives every node a finite position", () => {
    const { state } = seed(3);

    for (const [, point] of place(state)) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("places every node the scene contains", () => {
    const { state } = seed(3);
    const built = scene(state);
    const placed = place(state);

    for (const node of built.nodes) expect(placed.has(node.id)).toBe(true);
  });

  it("clamps a wild pinned position rather than propagating it", () => {
    const { state, runIds } = seed(1);
    const placed = place(state, {
      [runSpatialId(runIds[0])]: { x: 1e12, y: Number.NaN },
    });

    const point = placed.get(runSpatialId(runIds[0]))!;
    expect(point.x).toBe(MAX_GRAPH_COORD);
    expect(point.y).toBe(0);
  });
});

describe("stability across polling", () => {
  it("does not move an existing run when another run appears", () => {
    const { state, agentId } = seed(1);
    const before = place(state);

    const added = createRun(state, { agentId, workspaceId: "wA", title: "Later" }, T0 + 10);
    if (!added.ok) throw new Error("fixture failed");
    const after = place(added.state);

    expect(placementsAgree(before, after)).toBe(true);
    expect(after.size).toBeGreaterThan(before.size);
  });

  it("does not move anything when a run's status changes", () => {
    const { state, runIds } = seed(2);
    const before = place(state);

    const moved = transitionRunStatus(state, runIds[0], "waiting", T0 + 50);
    if (!moved.ok) throw new Error("fixture failed");

    expect(placementsAgree(before, place(moved.state))).toBe(true);
  });

  it("does not move anything when a run's activity changes", () => {
    const { state, runIds } = seed(2);
    const before = place(state);

    const updated = updateRun(state, runIds[0], { currentActivity: "Edited a.ts" }, T0 + 50);
    if (!updated.ok) throw new Error("fixture failed");

    expect(placementsAgree(before, place(updated.state))).toBe(true);
  });

  it("does not move a run when it gains a file", () => {
    const { state, runIds } = seed(2);
    const before = place(state);

    const withFile = recordArtifactWork(
      state,
      { runId: runIds[0], projectPath: PROJECT, path: "src/a.ts", role: "edited" },
      T0 + 50
    );
    if (!withFile.ok) throw new Error("fixture failed");

    const after = place(withFile.state);
    expect(after.get(runSpatialId(runIds[0]))).toEqual(before.get(runSpatialId(runIds[0])));
  });

  it("does not move sibling runs when one run's files are disclosed", () => {
    const { state, runIds } = seed(3);
    let withFiles: AgentState = state;
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
      const result = recordArtifactWork(
        withFiles,
        { runId: runIds[1], projectPath: PROJECT, path, role: "edited" },
        T0 + 50
      );
      if (!result.ok) throw new Error("fixture failed");
      withFiles = result.state;
    }

    // Collapsed, then expanded by selecting the middle run.
    const collapsed = place(withFiles);
    const expanded = place(withFiles, {}, runSpatialId(runIds[1]));

    // Selecting discloses four files...
    expect(expanded.size).toBeGreaterThan(collapsed.size);
    // ...and moves none of the runs that were already placed.
    expect(placementsAgree(collapsed, expanded)).toBe(true);
  });

  it("starts the run column at the same slot however many runs there are", () => {
    // Runs created in one batch share a createdAt, so which of them occupies
    // slot 0 is decided by the id tiebreak — stable, but not the fixture's
    // creation order. The property that matters is that the column itself
    // begins in the same place: adding runs extends it downward rather than
    // shifting where it starts.
    function firstSlotOffset(fixture: ReturnType<typeof seed>): number {
      const placed = place(fixture.state);
      const agentY = placed.get(agentSpatialId(fixture.agentId))!.y;
      const runYs = fixture.runIds.map((id) => placed.get(runSpatialId(id))!.y);
      return Math.min(...runYs) - agentY;
    }

    // Within the deterministic per-id wobble.
    expect(Math.abs(firstSlotOffset(seed(1)) - firstSlotOffset(seed(5)))).toBeLessThanOrEqual(16);
  });

  it("orders a batch of same-instant runs deterministically", () => {
    // Every run in `seed` shares T0, so the id tiebreak alone decides the
    // order. It must still be total and repeatable.
    const { state } = seed(5);

    expect([...place(state).entries()]).toEqual([...place(state).entries()]);
  });

  it("keeps positions identical across a simulated reload", () => {
    const { state } = seed(3);
    const before = place(state);

    // A reload rebuilds from the same persisted domain state.
    const after = place(JSON.parse(JSON.stringify(state)) as AgentState);

    expect([...after.entries()]).toEqual([...before.entries()]);
  });
});

describe("dragged positions", () => {
  it("honours a pinned position over the computed one", () => {
    const { state, runIds } = seed(2);
    const pinned = { [runSpatialId(runIds[0])]: { x: 1234, y: -567 } };

    expect(place(state, pinned).get(runSpatialId(runIds[0]))).toEqual({ x: 1234, y: -567 });
  });

  it("leaves other nodes where they were when one is pinned", () => {
    const { state, runIds } = seed(3);
    const before = place(state);
    const after = place(state, { [runSpatialId(runIds[0])]: { x: 999, y: 999 } });

    for (const id of before.keys()) {
      if (id === runSpatialId(runIds[0])) continue;
      expect(after.get(id)).toEqual(before.get(id));
    }
  });

  it("keeps a pinned position when the run's status changes", () => {
    const { state, runIds } = seed(2);
    const pinned = { [runSpatialId(runIds[0])]: { x: 50, y: 60 } };

    const moved = transitionRunStatus(state, runIds[0], "completed", T0 + 50);
    if (!moved.ok) throw new Error("fixture failed");

    expect(place(moved.state, pinned).get(runSpatialId(runIds[0]))).toEqual({ x: 50, y: 60 });
  });
});

describe("arrangement", () => {
  it("places the agent column clear of the tab graph", () => {
    const { state, agentId } = seed(1);
    const point = place(state).get(agentSpatialId(agentId))!;

    expect(point.x).toBeGreaterThan(TAB_BOUNDS.maxX);
  });

  it("falls back to the origin when there are no tabs", () => {
    const { state, agentId } = seed(1);
    const placed = placeAgentScene({ scene: scene(state), pinned: {}, tabBounds: null });

    expect(placed.get(agentSpatialId(agentId))).toEqual({ x: 0, y: 0 });
  });

  it("indents runs to the right of their agent", () => {
    const { state, agentId, runIds } = seed(1);
    const placed = place(state);

    expect(placed.get(runSpatialId(runIds[0]))!.x).toBeGreaterThan(
      placed.get(agentSpatialId(agentId))!.x
    );
  });

  it("indents files to the right of their run", () => {
    const { state, runIds } = seed(1);
    const withFile = recordArtifactWork(
      state,
      { runId: runIds[0], projectPath: PROJECT, path: "src/a.ts", role: "edited" },
      T0
    );
    if (!withFile.ok) throw new Error("fixture failed");

    const placed = place(withFile.state);
    const artifactId = withFile.state.artifacts[0].id;
    const artifactPoint = placed.get(`artifact:${artifactId}`)!;

    expect(artifactPoint.x).toBeGreaterThan(placed.get(runSpatialId(runIds[0]))!.x);
  });

  it("gives separate runs separate positions", () => {
    const { state, runIds } = seed(4);
    const placed = place(state);

    const points = runIds.map((id) => JSON.stringify(placed.get(runSpatialId(id))));
    expect(new Set(points).size).toBe(runIds.length);
  });

  it("stacks many runs without collapsing them onto one point", () => {
    const { state } = seed(20);
    const placed = place(state);

    const ys = [...placed.values()].map((p) => p.y);
    expect(new Set(ys).size).toBeGreaterThan(15);
  });
});

describe("placementsAgree", () => {
  it("accepts a superset that preserves shared positions", () => {
    const before = new Map([["a", { x: 1, y: 2 }]]);
    const after = new Map([
      ["a", { x: 1, y: 2 }],
      ["b", { x: 9, y: 9 }],
    ]);

    expect(placementsAgree(before, after)).toBe(true);
  });

  it("rejects a moved node", () => {
    const before = new Map([["a", { x: 1, y: 2 }]]);
    const after = new Map([["a", { x: 1, y: 3 }]]);

    expect(placementsAgree(before, after)).toBe(false);
  });

  it("ignores a node that has disappeared", () => {
    const before = new Map([
      ["a", { x: 1, y: 2 }],
      ["gone", { x: 0, y: 0 }],
    ]);
    const after = new Map([["a", { x: 1, y: 2 }]]);

    expect(placementsAgree(before, after)).toBe(true);
  });
});
