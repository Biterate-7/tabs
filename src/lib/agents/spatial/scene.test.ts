import { describe, expect, it } from "vitest";
import { ingestObservation } from "@/lib/agents/adapter";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { addRunLink } from "@/lib/agents/links";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { buildAgentSpatialScene, emphasizedEdgeIds, linkedTabIds, runMatchesFilter } from "./scene";
import {
  RECENT_RUN_WINDOW_MS,
  agentSpatialId,
  artifactSpatialId,
  runSpatialId,
  tabSpatialId,
} from "./types";
import type { AgentRunStatus, AgentState } from "@/lib/agents/types";
import type { AgentSpatialFilter } from "./types";

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

function withArtifact(state: AgentState, runId: string, path: string, role: "edited" | "inspected" = "edited") {
  const result = recordArtifactWork(state, { runId, projectPath: PROJECT, path, role }, T0);
  if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
  return result.state;
}

function withTab(state: AgentState, runId: string, tabId: string, workspaceId = "wA") {
  const result = addRunLink(state, { runId, tabId, role: "context", tabWorkspaceId: workspaceId }, T0);
  if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
  return result.state;
}

function setStatus(state: AgentState, runId: string, status: AgentRunStatus, at = T0 + 10) {
  const result = transitionRunStatus(state, runId, status, at);
  if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
  return result.state;
}

function build(
  state: AgentState,
  over: Partial<{ workspaceId: string; filter: AgentSpatialFilter; selectedId: string | null; now: number }> = {}
) {
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

describe("an empty workspace", () => {
  it("produces nothing when there are no runs", () => {
    expect(build(emptyAgentState())).toEqual({ nodes: [], edges: [], hiddenRunCount: 0 });
  });

  it("produces nothing when no workspace is selected", () => {
    const { state } = seed();
    expect(build(state, { workspaceId: "" }).nodes).toEqual([]);
  });
});

describe("node construction", () => {
  it("builds an agent node and a run node", () => {
    const { state, agentId, runId } = seed();
    const scene = build(state);

    const agent = scene.nodes.find((n) => n.kind === "agent");
    expect(agent?.id).toBe(agentSpatialId(agentId));
    expect(agent).toMatchObject({ label: "Claude Code", provider: "p", activeRunCount: 1 });

    const run = scene.nodes.find((n) => n.kind === "run");
    expect(run?.id).toBe(runSpatialId(runId));
    expect(run).toMatchObject({ label: "Implement auth", status: "working" });
  });

  it("uses stable namespaced ids, never array positions", () => {
    const { state, agentId, runId } = seed();
    const scene = build(state);

    expect(scene.nodes.map((n) => n.id).sort()).toEqual(
      [agentSpatialId(agentId), runSpatialId(runId)].sort()
    );
  });

  it("gives the same ids across repeated builds", () => {
    const { state } = seed();

    expect(build(state).nodes.map((n) => n.id)).toEqual(build(state).nodes.map((n) => n.id));
  });

  it("falls back to the agent name when a run has no title", () => {
    const agent = createAgent(emptyAgentState(), { provider: "p", name: "Claude Code" }, T0);
    if (!agent.ok) throw new Error("fixture failed");
    const run = createRun(agent.state, { agentId: agent.agent.id, workspaceId: "wA" }, T0);
    if (!run.ok) throw new Error("fixture failed");

    const node = build(run.state).nodes.find((n) => n.kind === "run");
    expect(node?.label).toBe("Claude Code");
  });

  it("counts a run's tabs and artifacts without disclosing them", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Other");
    state = second.state;
    state = withArtifact(state, runId, "src/a.ts");
    state = withArtifact(state, runId, "src/b.ts");
    state = withTab(state, runId, "t1");

    // Two runs, so neither is auto-disclosed.
    const run = build(state).nodes.find((n) => n.kind === "run" && n.id === runSpatialId(runId));
    expect(run).toMatchObject({ artifactCount: 2, tabCount: 1 });
    expect(build(state).nodes.filter((n) => n.kind === "artifact")).toEqual([]);
  });

  it("counts a file touched twice by one run once", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    state = addRun(state, agentId, "wA", "Other").state;
    state = withArtifact(state, runId, "src/a.ts", "inspected");
    state = withArtifact(state, runId, "src/a.ts", "edited");

    const run = build(state).nodes.find((n) => n.kind === "run" && n.id === runSpatialId(runId));
    expect(run).toMatchObject({ artifactCount: 1 });
  });
});

describe("workspace isolation", () => {
  it("shows only runs from the requested workspace", () => {
    const fx = seed("wA");
    const { agentId } = fx;
    let state = fx.state;
    state = addRun(state, agentId, "wB", "Elsewhere").state;

    const scene = build(state, { workspaceId: "wA" });
    expect(scene.nodes.filter((n) => n.kind === "run").map((n) => n.kind === "run" && n.label)).toEqual([
      "Implement auth",
    ]);
  });

  it("shows the other workspace's run when asked for that workspace", () => {
    const fx = seed("wA");
    const { agentId } = fx;
    let state = fx.state;
    state = addRun(state, agentId, "wB", "Elsewhere").state;

    const scene = build(state, { workspaceId: "wB" });
    expect(scene.nodes.filter((n) => n.kind === "run").map((n) => n.kind === "run" && n.label)).toEqual([
      "Elsewhere",
    ]);
  });

  it("never leaks another workspace's artifacts", () => {
    const fx = seed("wA");
    const { agentId } = fx;
    let state = fx.state;
    const other = addRun(state, agentId, "wB", "Elsewhere");
    state = withArtifact(other.state, other.runId, "src/secret.ts");

    const scene = build(state, { workspaceId: "wA" });
    expect(scene.nodes.filter((n) => n.kind === "artifact")).toEqual([]);
    expect(JSON.stringify(scene)).not.toContain("secret.ts");
  });
});

describe("filters", () => {
  const cases: Array<[AgentRunStatus, AgentSpatialFilter, boolean]> = [
    ["working", "active", true],
    ["waiting", "active", true],
    ["completed", "finished", true],
    ["working", "finished", false],
    ["waiting", "waiting", true],
    ["working", "waiting", false],
    ["failed", "attention", true],
    ["blocked", "attention", true],
    ["completed", "attention", false],
    ["completed", "all", true],
    ["failed", "all", true],
  ];

  for (const [status, filter, expected] of cases) {
    it(`${status} under "${filter}" → ${expected ? "shown" : "hidden"}`, () => {
      const run = { status, updatedAt: T0, endedAt: T0 } as never;
      expect(runMatchesFilter(run, filter, T0 + RECENT_RUN_WINDOW_MS * 2)).toBe(expected);
    });
  }

  it("keeps a recently finished run in the active view", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = setStatus(state, runId, "completed", T0);

    expect(build(state, { now: T0 + 1000 }).nodes.some((n) => n.kind === "run")).toBe(true);
  });

  it("drops a long-finished run from the active view and counts it as hidden", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = setStatus(state, runId, "completed", T0);

    const scene = build(state, { now: T0 + RECENT_RUN_WINDOW_MS * 2 });
    expect(scene.nodes.some((n) => n.kind === "run")).toBe(false);
    expect(scene.hiddenRunCount).toBe(1);
  });

  it("reports nothing hidden when everything is visible", () => {
    const { state } = seed();
    expect(build(state).hiddenRunCount).toBe(0);
  });

  it("hides the agent when all of its runs are filtered out", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = setStatus(state, runId, "completed", T0);

    const scene = build(state, { now: T0 + RECENT_RUN_WINDOW_MS * 2 });
    expect(scene.nodes).toEqual([]);
  });
});

describe("progressive disclosure", () => {
  it("discloses the files of a single run without a click", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withArtifact(state, runId, "src/a.ts");

    const artifacts = build(state).nodes.filter((n) => n.kind === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind === "artifact" && artifacts[0].label).toBe("a.ts");
  });

  it("keeps files collapsed when several runs compete for the canvas", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Other");
    state = withArtifact(second.state, runId, "src/a.ts");

    expect(build(state).nodes.filter((n) => n.kind === "artifact")).toEqual([]);
  });

  it("discloses a selected run's files", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Other");
    state = withArtifact(second.state, runId, "src/a.ts");
    state = withArtifact(state, second.runId, "src/b.ts");

    const scene = build(state, { selectedId: runSpatialId(runId) });
    const labels = scene.nodes.filter((n) => n.kind === "artifact").map((n) => n.kind === "artifact" && n.label);
    expect(labels).toEqual(["a.ts"]);
  });

  it("discloses the runs around a selected artifact", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Other");
    state = withArtifact(second.state, runId, "src/shared.ts");
    state = withArtifact(state, second.runId, "src/shared.ts");

    const artifactId = state.artifacts[0].id;
    const scene = build(state, { selectedId: artifactSpatialId(artifactId) });

    expect(scene.nodes.filter((n) => n.kind === "artifact")).toHaveLength(1);
    // Both runs touched it, so both disclose.
    expect(scene.edges.filter((e) => e.target === artifactSpatialId(artifactId))).toHaveLength(2);
  });

  it("shows one artifact node for a file two runs share", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Other");
    state = withArtifact(second.state, runId, "src/shared.ts");
    state = withArtifact(state, second.runId, "src/shared.ts", "inspected");

    const scene = build(state, { selectedId: runSpatialId(runId) });
    const artifacts = scene.nodes.filter((n) => n.kind === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind === "artifact" && artifacts[0].runCount).toBe(2);
  });
});

describe("edges", () => {
  it("connects an agent to its runs", () => {
    const { state, agentId, runId } = seed();
    const scene = build(state);

    expect(scene.edges).toContainEqual({
      id: `owns:${agentId}:${runId}`,
      source: agentSpatialId(agentId),
      target: runSpatialId(runId),
      kind: "owns",
    });
  });

  it("carries the artifact role as the edge kind", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withArtifact(state, runId, "src/a.ts", "inspected");
    state = withArtifact(state, runId, "src/b.ts", "edited");

    const kinds = build(state)
      .edges.filter((e) => e.target.startsWith("artifact:"))
      .map((e) => e.kind)
      .sort();
    expect(kinds).toEqual(["edited", "inspected"]);
  });

  it("carries the tab role as the edge kind and points at the tab layer", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withTab(state, runId, "t1");

    const edge = build(state).edges.find((e) => e.target.startsWith("tab:"));
    expect(edge).toMatchObject({ kind: "context", target: tabSpatialId("t1") });
  });

  it("draws no artifact edge for an artifact it did not disclose", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    state = addRun(state, agentId, "wA", "Other").state;
    state = withArtifact(state, runId, "src/a.ts");

    expect(build(state).edges.filter((e) => e.target.startsWith("artifact:"))).toEqual([]);
  });

  it("reports the tab ids it wants the canvas to resolve", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withTab(state, runId, "t1");

    expect([...linkedTabIds(build(state))]).toEqual(["t1"]);
  });
});

describe("emphasis", () => {
  it("emphasizes structural edges when nothing is selected", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withArtifact(state, runId, "src/a.ts");

    const scene = build(state);
    const emphasized = emphasizedEdgeIds(scene, null);

    expect([...emphasized].every((id) => id.startsWith("owns:"))).toBe(true);
  });

  it("emphasizes a selected node's own edges", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withArtifact(state, runId, "src/a.ts");

    const scene = build(state, { selectedId: runSpatialId(runId) });
    const emphasized = emphasizedEdgeIds(scene, runSpatialId(runId));

    for (const edge of scene.edges) {
      const touches = edge.source === runSpatialId(runId) || edge.target === runSpatialId(runId);
      expect(emphasized.has(edge.id)).toBe(touches);
    }
  });
});

describe("agent status summary", () => {
  it("reports the status that most wants attention", () => {
    const fx = seed();
    const { agentId, runId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Broken");
    state = setStatus(second.state, second.runId, "failed");

    const agent = build(state, { filter: "all" }).nodes.find((n) => n.kind === "agent");
    expect(agent?.kind === "agent" && agent.status).toBe("failed");
    expect(agent?.kind === "agent" && agent.activeRunCount).toBe(1);
    void runId;
  });

  it("reports working over completed", () => {
    const fx = seed();
    const { agentId } = fx;
    let state = fx.state;
    const second = addRun(state, agentId, "wA", "Done");
    state = setStatus(second.state, second.runId, "completed", T0);

    const agent = build(state, { filter: "all" }).nodes.find((n) => n.kind === "agent");
    expect(agent?.kind === "agent" && agent.status).toBe("working");
  });
});

describe("what the scene exposes", () => {
  it("carries project-relative paths and no absolute one", () => {
    const fx = seed();
    const { runId } = fx;
    let state = fx.state;
    state = withArtifact(state, runId, `${PROJECT}\\src\\deep\\file.ts`);

    const scene = build(state);
    const artifact = scene.nodes.find((n) => n.kind === "artifact");

    expect(artifact?.kind === "artifact" && artifact.relativePath).toBe("src/deep/file.ts");
    expect(artifact?.kind === "artifact" && artifact.label).toBe("file.ts");
    expect(JSON.stringify(scene)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("carries only sanitised activity from the domain", () => {
    const { state, agentId } = seed();
    const ingested = ingestObservation(state, {
      agentId,
      observation: {
        provider: "p",
        externalId: "s1",
        workspaceId: "wA",
        activity: "Edited sidebar.tsx",
      },
      now: T0,
    });
    if (!ingested.ok) throw new Error("fixture failed");

    const run = build(ingested.state).nodes.find(
      (n) => n.kind === "run" && n.id === runSpatialId(ingested.run!.id)
    );
    expect(run?.kind === "run" && run.activity).toBe("Edited sidebar.tsx");
  });
});
