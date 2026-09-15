import { describe, expect, it } from "vitest";
import { recordArtifactWork } from "@/lib/agents/artifacts";
import { createAgent } from "@/lib/agents/registry";
import { createRun, transitionRunStatus, updateRun } from "@/lib/agents/runs";
import { emptyAgentState } from "@/lib/agents/types";
import { buildAgentSpatialScene } from "./scene";
import { searchAgentScene, searchAgentWork, searchHiddenArtifacts } from "./search";
import { artifactSpatialId, runSpatialId } from "./types";
import type { AgentSpatialFilter } from "./types";
import type { AgentState } from "@/lib/agents/types";

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";

function seed(workspaceId = "wA", title = "Implement authentication") {
  const agent = createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  const run = createRun(agent.state, { agentId: agent.agent.id, workspaceId, title }, T0);
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, agentId: agent.agent.id, runId: run.run.id };
}

function withArtifact(state: AgentState, runId: string, path: string) {
  const result = recordArtifactWork(state, { runId, projectPath: PROJECT, path, role: "edited" }, T0);
  if (!result.ok) throw new Error("fixture failed");
  return result.state;
}

function scene(state: AgentState, workspaceId = "wA", filter: AgentSpatialFilter = "all", selectedId: string | null = null) {
  return buildAgentSpatialScene(state, {
    agents: state.agents,
    runs: state.runs,
    artifacts: state.artifacts,
    workspaceId,
    filter,
    selectedId,
    now: T0 + 1000,
  });
}

function hiddenInput(state: AgentState, workspaceId = "wA") {
  const built = scene(state, workspaceId);
  return {
    artifacts: state.artifacts,
    artifactLinks: state.artifactLinks,
    workspaceId,
    visibleRunIds: new Set(built.nodes.filter((n) => n.kind === "run").map((n) => n.runId)),
  };
}

describe("searching the scene", () => {
  it("finds a run by its title", () => {
    const { state, runId } = seed();
    const results = searchAgentScene(scene(state), "authentication");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: runSpatialId(runId), kind: "run", typeLabel: "Agent run" });
  });

  it("finds a run by its safe activity summary", () => {
    const fixture = seed();
    const updated = updateRun(fixture.state, fixture.runId, { currentActivity: "Edited sidebar.tsx" }, T0);
    if (!updated.ok) throw new Error("fixture failed");

    const results = searchAgentScene(scene(updated.state), "sidebar");
    expect(results[0]?.kind).toBe("run");
    expect(results[0]?.detail).toBe("Edited sidebar.tsx");
  });

  it("finds an agent by name and by provider", () => {
    const { state } = seed();

    expect(searchAgentScene(scene(state), "Claude Code").some((r) => r.kind === "agent")).toBe(true);
    expect(searchAgentScene(scene(state), "claude-code").some((r) => r.kind === "agent")).toBe(true);
  });

  it("finds a run by status", () => {
    const { state } = seed();

    expect(searchAgentScene(scene(state), "working").some((r) => r.kind === "run")).toBe(true);
  });

  it("finds a disclosed file by basename and by path segment", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/lib/agents/artifacts.ts");

    // A single run auto-discloses its files.
    expect(searchAgentScene(scene(state), "artifacts.ts").some((r) => r.kind === "artifact")).toBe(true);
    expect(searchAgentScene(scene(state), "lib/agents").some((r) => r.kind === "artifact")).toBe(true);
  });

  it("labels each result with its type so a run does not read as a tab", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");
    const kinds = new Map(searchAgentScene(scene(state), "").map((r) => [r.kind, r.typeLabel]));

    expect(kinds.size).toBe(0); // empty query finds nothing
    const all = searchAgentScene(scene(state), "a");
    for (const result of all) {
      expect(["Agent", "Agent run", "File"]).toContain(result.typeLabel);
    }
  });

  it("returns nothing for an empty query", () => {
    const { state } = seed();

    expect(searchAgentScene(scene(state), "")).toEqual([]);
    expect(searchAgentScene(scene(state), "   ")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const { state } = seed();

    expect(searchAgentScene(scene(state), "AUTHENTICATION")).toHaveLength(1);
  });

  it("ranks runs above files and agents", () => {
    const fixture = seed("wA", "alpha run");
    const state = withArtifact(fixture.state, fixture.runId, "src/alpha.ts");
    const results = searchAgentScene(scene(state), "alpha");

    expect(results[0].kind).toBe("run");
  });
});

describe("what search will not surface", () => {
  it("never matches on the absolute project root", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");

    // The root is in the artifact's identity but must not be searchable, or
    // it would be printed back to the user as a result detail.
    expect(searchAgentScene(scene(state), "C:\\repo")).toEqual([]);
    expect(searchAgentScene(scene(state), "repo/project")).toEqual([]);
  });

  it("carries no absolute path in any result field", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");

    for (const result of searchAgentScene(scene(state), "a")) {
      expect(result.label).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(result.detail ?? "").not.toMatch(/[A-Za-z]:[\\/]/);
    }
  });
});

describe("workspace scoping", () => {
  it("does not return another workspace's run", () => {
    const fixture = seed("wA", "alpha run");
    const other = createRun(
      fixture.state,
      { agentId: fixture.agentId, workspaceId: "wB", title: "alpha elsewhere" },
      T0
    );
    if (!other.ok) throw new Error("fixture failed");

    const results = searchAgentScene(scene(other.state, "wA"), "alpha");
    expect(results.map((r) => r.label)).toEqual(["alpha run"]);
  });

  it("does not return another workspace's file", () => {
    const fixture = seed("wA");
    const other = createRun(fixture.state, { agentId: fixture.agentId, workspaceId: "wB" }, T0);
    if (!other.ok) throw new Error("fixture failed");
    const state = withArtifact(other.state, other.run.id, "src/secret.ts");

    expect(searchAgentWork(scene(state, "wA"), hiddenInput(state, "wA"), "secret")).toEqual([]);
  });
});

describe("filter scoping", () => {
  it("does not return a run the active filter hides", () => {
    const fixture = seed("wA", "finished work");
    const done = transitionRunStatus(fixture.state, fixture.runId, "completed", T0);
    if (!done.ok) throw new Error("fixture failed");

    // Long past the recent window, so "active" excludes it.
    const built = buildAgentSpatialScene(done.state, {
      agents: done.state.agents,
      runs: done.state.runs,
      artifacts: done.state.artifacts,
      workspaceId: "wA",
      filter: "active",
      selectedId: null,
      now: T0 + 30 * 60 * 60 * 1000,
    });

    expect(searchAgentScene(built, "finished")).toEqual([]);
    // ...but "all" finds it, which is the documented interaction: search
    // looks within what is currently eligible.
    expect(searchAgentScene(scene(done.state, "wA", "all"), "finished")).toHaveLength(1);
  });
});

describe("hidden files", () => {
  it("finds a file whose run has not been selected", () => {
    const fixture = seed();
    // A second run means neither auto-discloses.
    const second = createRun(fixture.state, { agentId: fixture.agentId, workspaceId: "wA", title: "Other" }, T0);
    if (!second.ok) throw new Error("fixture failed");
    const state = withArtifact(second.state, fixture.runId, "src/hidden-file.ts");

    const built = scene(state);
    expect(built.nodes.filter((n) => n.kind === "artifact")).toEqual([]);

    const results = searchHiddenArtifacts(hiddenInput(state), "hidden-file", new Set());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "artifact", detail: "src/hidden-file.ts" });
  });

  it("does not duplicate a file the scene already shows", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");
    const built = scene(state);

    const shown = searchAgentScene(built, "a.ts");
    const artifactId = state.artifacts[0].id;
    const hidden = searchHiddenArtifacts(
      hiddenInput(state),
      "a.ts",
      new Set([artifactSpatialId(artifactId)])
    );

    expect(shown.some((r) => r.kind === "artifact")).toBe(true);
    expect(hidden).toEqual([]);
  });

  it("does not surface a file whose every run is filtered out", () => {
    const fixture = seed();
    const state = withArtifact(fixture.state, fixture.runId, "src/a.ts");

    const results = searchHiddenArtifacts(
      { ...hiddenInput(state), visibleRunIds: new Set() },
      "a.ts",
      new Set()
    );

    expect(results).toEqual([]);
  });
});

describe("searchAgentWork", () => {
  it("combines scene and hidden results without duplicates", () => {
    const fixture = seed();
    const second = createRun(fixture.state, { agentId: fixture.agentId, workspaceId: "wA", title: "Other" }, T0);
    if (!second.ok) throw new Error("fixture failed");
    let state = withArtifact(second.state, fixture.runId, "src/alpha.ts");
    state = withArtifact(state, second.run.id, "src/alpha-two.ts");

    const results = searchAgentWork(scene(state), hiddenInput(state), "alpha");
    const ids = results.map((r) => r.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(results.filter((r) => r.kind === "artifact")).toHaveLength(2);
  });

  it("caps how many results a broad query can return", () => {
    const fixture = seed();
    let state = fixture.state;
    for (let i = 0; i < 60; i += 1) {
      state = withArtifact(state, fixture.runId, `src/file-${i}.ts`);
    }

    expect(searchAgentWork(scene(state), hiddenInput(state), "file", 25).length).toBeLessThanOrEqual(25);
  });
});
