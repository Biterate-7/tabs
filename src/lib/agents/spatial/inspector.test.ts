import { describe, expect, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { appendRunEvent } from "@/lib/agents/events";
import { addRunLink } from "@/lib/agents/links";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus, updateRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { INSPECTOR_EVENT_LIMIT, buildInspectorSelection } from "./inspector";
import { buildAgentSpatialScene } from "./scene";
import { agentSpatialId, artifactSpatialId, runSpatialId } from "./types";
import type { AgentState } from "@/lib/agents/types";

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";

function seed() {
  const agent = createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(
    agent.state,
    { agentId: agent.agent.id, workspaceId: "wA", title: "Implement auth" },
    T0
  );
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, agentId: agent.agent.id, runId: run.run.id };
}

function withArtifact(
  state: AgentState,
  runId: string,
  path: string,
  role: "edited" | "inspected" = "edited"
) {
  const result = recordArtifactWork(state, { runId, projectPath: PROJECT, path, role }, T0);
  if (!result.ok) throw new Error("fixture failed");
  return result.state;
}

function withTab(state: AgentState, runId: string, tabId: string, role: "context" | "produced" = "context") {
  const result = addRunLink(state, { runId, tabId, role, tabWorkspaceId: "wA" }, T0);
  if (!result.ok) throw new Error("fixture failed");
  return result.state;
}

function inspect(state: AgentState, selectedId: string | null, tabTitles = new Map<string, string>()) {
  const scene = buildAgentSpatialScene(state, {
    agents: state.agents,
    runs: state.runs,
    artifacts: state.artifacts,
    workspaceId: "wA",
    filter: "all",
    selectedId,
    now: T0 + 1000,
  });
  return buildInspectorSelection({ state, scene, selectedId, tabTitles });
}

describe("nothing selected", () => {
  it("returns null", () => {
    const { state } = seed();

    expect(inspect(state, null)).toBeNull();
  });

  it("returns null for an id the scene does not contain", () => {
    const { state } = seed();

    expect(inspect(state, "run:does-not-exist")).toBeNull();
  });
});

describe("inspecting a run", () => {
  it("reports identity, status and agent name", () => {
    const { state, runId } = seed();
    const selection = inspect(state, runSpatialId(runId));

    expect(selection?.kind).toBe("run");
    if (selection?.kind !== "run") throw new Error("expected a run");
    expect(selection.node.label).toBe("Implement auth");
    expect(selection.node.status).toBe("working");
    expect(selection.agentName).toBe("Claude Code");
  });

  it("lists files with their roles, by project-relative path", () => {
    const fixture = seed();
    let state = withArtifact(fixture.state, fixture.runId, "src/lib/agents/artifacts.ts", "edited");
    state = withArtifact(state, fixture.runId, "src/lib/agents/paths.ts", "inspected");

    const selection = inspect(state, runSpatialId(fixture.runId));
    if (selection?.kind !== "run") throw new Error("expected a run");

    expect(selection.files).toHaveLength(2);
    expect(selection.files.map((f) => f.relativePath)).toEqual([
      "src/lib/agents/artifacts.ts",
      "src/lib/agents/paths.ts",
    ]);
    expect(selection.files.map((f) => f.role).sort()).toEqual(["edited", "inspected"]);
    for (const file of selection.files) {
      expect(file.relativePath).not.toMatch(/[A-Za-z]:[\\/]/);
    }
  });

  it("lists tabs separately from files, with their roles", () => {
    const fixture = seed();
    let state = withArtifact(fixture.state, fixture.runId, "src/a.ts");
    state = withTab(state, fixture.runId, "t1", "context");
    state = withTab(state, fixture.runId, "t2", "produced");

    const titles = new Map([
      ["t1", "API reference"],
      ["t2", "Pull request"],
    ]);
    const selection = inspect(state, runSpatialId(fixture.runId), titles);
    if (selection?.kind !== "run") throw new Error("expected a run");

    expect(selection.tabs.map((t) => t.title)).toEqual(["API reference", "Pull request"]);
    expect(selection.tabs.map((t) => t.role).sort()).toEqual(["context", "produced"]);
    expect(selection.files).toHaveLength(1);
  });

  it("names a tab that has since been deleted rather than dropping it", () => {
    const fixture = seed();
    const state = withTab(fixture.state, fixture.runId, "gone");

    const selection = inspect(state, runSpatialId(fixture.runId), new Map());
    if (selection?.kind !== "run") throw new Error("expected a run");

    expect(selection.tabs).toHaveLength(1);
    expect(selection.tabs[0].title).toBe("Deleted tab");
  });

  it("lists recent events newest first, bounded", () => {
    const fixture = seed();
    let state = fixture.state;
    for (let i = 0; i < INSPECTOR_EVENT_LIMIT + 8; i += 1) {
      const appended = appendRunEvent(state, {
        runId: fixture.runId,
        kind: "activity",
        summary: `Event ${i}`,
        timestamp: T0 + i,
      });
      if (!appended.ok) throw new Error("fixture failed");
      state = appended.state;
    }

    const selection = inspect(state, runSpatialId(fixture.runId));
    if (selection?.kind !== "run") throw new Error("expected a run");

    expect(selection.events).toHaveLength(INSPECTOR_EVENT_LIMIT);
    expect(selection.events[0].summary).toBe(`Event ${INSPECTOR_EVENT_LIMIT + 7}`);
  });

  it("reports started time, and endedAt only once the domain says so", () => {
    const fixture = seed();
    const live = inspect(fixture.state, runSpatialId(fixture.runId));
    if (live?.kind !== "run") throw new Error("expected a run");

    expect(live.startedAt).toBe(T0);
    // Never inferred from a session disappearing.
    expect(live.endedAt).toBeUndefined();

    const done = transitionRunStatus(fixture.state, fixture.runId, "completed", T0 + 5000);
    if (!done.ok) throw new Error("fixture failed");
    const finished = inspect(done.state, runSpatialId(fixture.runId));
    if (finished?.kind !== "run") throw new Error("expected a run");

    expect(finished.endedAt).toBe(T0 + 5000);
  });

  it("carries the sanitised activity line", () => {
    const fixture = seed();
    const updated = updateRun(fixture.state, fixture.runId, { currentActivity: "Edited sidebar.tsx" }, T0);
    if (!updated.ok) throw new Error("fixture failed");

    const selection = inspect(updated.state, runSpatialId(fixture.runId));
    if (selection?.kind !== "run") throw new Error("expected a run");
    expect(selection.node.activity).toBe("Edited sidebar.tsx");
  });

  it("handles a run with no files, tabs or events", () => {
    const { state, runId } = seed();
    const selection = inspect(state, runSpatialId(runId));
    if (selection?.kind !== "run") throw new Error("expected a run");

    expect(selection.files).toEqual([]);
    expect(selection.tabs).toEqual([]);
    expect(selection.events).toEqual([]);
  });
});

describe("inspecting an agent", () => {
  it("reports provider, counts and recent runs", () => {
    const fixture = seed();
    const second = createRun(
      fixture.state,
      { agentId: fixture.agentId, workspaceId: "wA", title: "Second run" },
      T0 + 10
    );
    if (!second.ok) throw new Error("fixture failed");

    const selection = inspect(second.state, agentSpatialId(fixture.agentId));
    if (selection?.kind !== "agent") throw new Error("expected an agent");

    expect(selection.node.provider).toBe("claude-code");
    expect(selection.node.activeRunCount).toBe(2);
    expect(selection.recentRuns).toHaveLength(2);
    expect(selection.recentRuns[0].title).toBe("Second run");
  });

  it("exposes no session identifier", () => {
    const fixture = seed();
    const tagged = updateRun(fixture.state, fixture.runId, { externalId: "sess-secret-id" }, T0);
    if (!tagged.ok) throw new Error("fixture failed");

    const selection = inspect(tagged.state, agentSpatialId(fixture.agentId));
    expect(JSON.stringify(selection)).not.toContain("sess-secret-id");
  });
});

describe("inspecting an artifact", () => {
  it("reports the file and which runs worked on it, with roles", () => {
    const fixture = seed();
    const second = createRun(fixture.state, { agentId: fixture.agentId, workspaceId: "wA", title: "Other" }, T0);
    if (!second.ok) throw new Error("fixture failed");

    let state = withArtifact(second.state, fixture.runId, "src/shared.ts", "edited");
    state = withArtifact(state, second.run.id, "src/shared.ts", "inspected");

    const artifactId = state.artifacts[0].id;
    const selection = inspect(state, artifactSpatialId(artifactId));
    if (selection?.kind !== "artifact") throw new Error("expected an artifact");

    expect(selection.node.relativePath).toBe("src/shared.ts");
    expect(selection.node.label).toBe("shared.ts");
    expect(selection.touchedBy).toHaveLength(2);
    expect(selection.touchedBy.map((t) => t.role).sort()).toEqual(["edited", "inspected"]);
    expect(selection.touchedBy.every((t) => t.agentName === "Claude Code")).toBe(true);
  });

  it("shows no absolute path and no file contents", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, `${PROJECT}\\src\\deep\\file.ts`);
    const artifactId = state.artifacts[0].id;

    const selection = inspect(state, artifactSpatialId(artifactId));
    if (selection?.kind !== "artifact") throw new Error("expected an artifact");

    expect(selection.node.relativePath).toBe("src/deep/file.ts");
    // The identity field carries the root; nothing the panel renders does.
    expect(selection.node.label).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(selection.node.relativePath).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});

describe("resilience", () => {
  it("survives an artifact link whose artifact is gone", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");
    // Simulates a deletion racing a render.
    const broken: AgentState = { ...state, artifacts: [] };

    const scene = buildAgentSpatialScene(state, {
      agents: state.agents,
      runs: state.runs,
      artifacts: state.artifacts,
      workspaceId: "wA",
      filter: "all",
      selectedId: runSpatialId(fixture.runId),
      now: T0 + 1000,
    });

    const selection = buildInspectorSelection({
      state: broken,
      scene,
      selectedId: runSpatialId(fixture.runId),
      tabTitles: new Map(),
    });
    if (selection?.kind !== "run") throw new Error("expected a run");

    expect(selection.files).toEqual([]);
  });

  it("survives an artifact whose run is gone", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");
    const artifactId = state.artifacts[0].id;

    const scene = buildAgentSpatialScene(state, {
      agents: state.agents,
      runs: state.runs,
      artifacts: state.artifacts,
      workspaceId: "wA",
      filter: "all",
      selectedId: artifactSpatialId(artifactId),
      now: T0 + 1000,
    });

    const selection = buildInspectorSelection({
      state: { ...state, runs: [] },
      scene,
      selectedId: artifactSpatialId(artifactId),
      tabTitles: new Map(),
    });
    if (selection?.kind !== "artifact") throw new Error("expected an artifact");

    expect(selection.touchedBy[0].runTitle).toBe("Untitled run");
  });
});
