import { describe, expect, it } from "vitest";
import {
  agentRunArtifactLinkId,
  findArtifactByIdentity,
  findWorkArtifact,
  linkRunArtifact,
  pruneOrphanedArtifacts,
  recordArtifactWork,
  removeArtifactLinksForRun,
  resolveWorkArtifact,
  workArtifactId,
} from "./artifacts";
import { createAgent, deleteAgentAndRuns } from "./registry";
import { createRun, deleteRun } from "./runs";
import {
  getArtifactLinksForRun,
  getArtifactLinksForRunByRole,
  getArtifactRoles,
  getArtifactsForRun,
  getArtifactsForWorkspace,
  getRunsForArtifact,
} from "./selectors";
import { emptyAgentState } from "./types";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";
const OTHER_PROJECT = "C:\\repo\\other";

/** An agent with one run in `wA` and, optionally, a second run. */
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

function record(
  state: AgentState,
  runId: string,
  path: string,
  role: "inspected" | "edited" | "created" | "deleted" = "edited",
  now = T0,
  projectPath = PROJECT
): AgentState {
  const result = recordArtifactWork(state, { runId, projectPath, path, role }, now);
  if (!result.ok) throw new Error(`record failed: ${result.reason}`);
  return result.state;
}

describe("artifact identity", () => {
  it("is deterministic for the same file", () => {
    expect(workArtifactId("wA", PROJECT, "src/foo.ts")).toBe(
      workArtifactId("wA", PROJECT, "src/foo.ts")
    );
  });

  it("treats the same project spelled differently as one project", () => {
    expect(workArtifactId("wA", "C:\\repo\\project", "src/foo.ts")).toBe(
      workArtifactId("wA", "c:/repo/project/", "src/foo.ts")
    );
  });

  it("separates the same relative path in different projects", () => {
    expect(workArtifactId("wA", PROJECT, "src/foo.ts")).not.toBe(
      workArtifactId("wA", OTHER_PROJECT, "src/foo.ts")
    );
  });

  it("separates the same file in different workspaces", () => {
    expect(workArtifactId("wA", PROJECT, "src/foo.ts")).not.toBe(
      workArtifactId("wB", PROJECT, "src/foo.ts")
    );
  });

  it("separates different files", () => {
    expect(workArtifactId("wA", PROJECT, "src/foo.ts")).not.toBe(
      workArtifactId("wA", PROJECT, "src/bar.ts")
    );
  });
});

describe("resolveWorkArtifact", () => {
  it("creates an artifact from an absolute path inside the project", () => {
    const { state } = seeded();
    const result = resolveWorkArtifact(
      state,
      { workspaceId: "wA", projectPath: PROJECT, path: "C:\\repo\\project\\src\\foo.ts" },
      T0
    );
    if (!result.ok) throw new Error("expected success");

    expect(result.created).toBe(true);
    expect(result.artifact.relativePath).toBe("src/foo.ts");
    expect(result.artifact.workspaceId).toBe("wA");
    expect(result.artifact.kind).toBe("file");
    expect(result.artifact.createdAt).toBe(T0);
  });

  it("stores no absolute path in the relative field", () => {
    const { state } = seeded();
    const result = resolveWorkArtifact(
      state,
      { workspaceId: "wA", projectPath: PROJECT, path: "C:\\repo\\project\\src\\foo.ts" },
      T0
    );
    if (!result.ok) throw new Error("expected success");

    expect(result.artifact.relativePath).not.toContain("C:");
    expect(result.artifact.relativePath).not.toContain("\\");
  });

  it("returns the same artifact for the same file, bumping only updatedAt", () => {
    const { state } = seeded();
    const first = resolveWorkArtifact(
      state,
      { workspaceId: "wA", projectPath: PROJECT, path: "src/foo.ts" },
      T0
    );
    if (!first.ok) throw new Error("expected success");

    const second = resolveWorkArtifact(
      first.state,
      { workspaceId: "wA", projectPath: PROJECT, path: "C:\\repo\\project\\src\\foo.ts" },
      T0 + 500
    );
    if (!second.ok) throw new Error("expected success");

    expect(second.created).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(second.artifact.createdAt).toBe(T0);
    expect(second.artifact.updatedAt).toBe(T0 + 500);
    expect(second.state.artifacts).toHaveLength(1);
  });

  it("refuses a path that escapes the project", () => {
    const { state } = seeded();

    expect(
      resolveWorkArtifact(state, { workspaceId: "wA", projectPath: PROJECT, path: "../../secret.txt" }, T0)
    ).toEqual({ ok: false, reason: "invalid-path" });
  });

  it("refuses a path under a different root", () => {
    const { state } = seeded();

    expect(
      resolveWorkArtifact(
        state,
        { workspaceId: "wA", projectPath: PROJECT, path: "C:\\other\\secret.txt" },
        T0
      )
    ).toEqual({ ok: false, reason: "invalid-path" });
  });

  it("refuses blank workspace or project", () => {
    const { state } = seeded();

    expect(
      resolveWorkArtifact(state, { workspaceId: "  ", projectPath: PROJECT, path: "a.ts" }, T0)
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      resolveWorkArtifact(state, { workspaceId: "wA", projectPath: " ", path: "a.ts" }, T0)
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("finds an artifact by its identity", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    expect(findArtifactByIdentity(next, "wA", PROJECT, "src/foo.ts")).toBeDefined();
    expect(findArtifactByIdentity(next, "wA", PROJECT, "src/missing.ts")).toBeUndefined();
    expect(findArtifactByIdentity(next, "wB", PROJECT, "src/foo.ts")).toBeUndefined();
  });
});

describe("linking a run to an artifact", () => {
  it("records each role", () => {
    const { state, runId } = seeded();
    let next = state;

    for (const role of ["inspected", "edited", "created", "deleted"] as const) {
      next = record(next, runId, "src/foo.ts", role);
    }

    expect(getArtifactLinksForRun(next, runId)).toHaveLength(4);
    expect(getArtifactRoles(next, runId, workArtifactId("wA", PROJECT, "src/foo.ts")).sort()).toEqual(
      ["created", "deleted", "edited", "inspected"]
    );
    // One file, four relationships.
    expect(next.artifacts).toHaveLength(1);
  });

  it("is idempotent for the same run, artifact and role", () => {
    const { state, runId } = seeded();
    const first = record(state, runId, "src/foo.ts", "edited");
    const second = record(first, runId, "src/foo.ts", "edited", T0 + 900);

    expect(second.artifactLinks).toHaveLength(1);
    expect(second.artifactLinks[0].createdAt).toBe(T0);
  });

  it("gives one file two relationships when two runs touch it", () => {
    const { state, runId, agentId } = seeded();
    const second = addRun(state, agentId, "wA");

    let next = record(second.state, runId, "src/foo.ts", "edited");
    next = record(next, second.runId, "src/foo.ts", "inspected");

    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactLinks).toHaveLength(2);
    expect(getRunsForArtifact(next, next.artifacts[0].id).map((r) => r.id).sort()).toEqual(
      [runId, second.runId].sort()
    );
  });

  it("refuses to link an artifact from another workspace", () => {
    const { state, runId, agentId } = seeded("wA");
    const other = addRun(state, agentId, "wB");

    // An artifact created in wB by the other run.
    const withArtifact = record(other.state, other.runId, "src/foo.ts", "edited");
    const artifactInB = withArtifact.artifacts[0];
    expect(artifactInB.workspaceId).toBe("wB");

    expect(
      linkRunArtifact(withArtifact, { runId, artifactId: artifactInB.id, role: "edited" }, T0)
    ).toEqual({ ok: false, reason: "cross-workspace" });
  });

  it("keeps the same file in two workspaces as two artifacts", () => {
    const { state, runId, agentId } = seeded("wA");
    const other = addRun(state, agentId, "wB");

    let next = record(other.state, runId, "src/foo.ts", "edited");
    next = record(next, other.runId, "src/foo.ts", "edited");

    expect(next.artifacts).toHaveLength(2);
    expect(next.artifacts.map((a) => a.workspaceId).sort()).toEqual(["wA", "wB"]);
  });

  it("rejects an unknown run or artifact", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    expect(linkRunArtifact(next, { runId: "ghost", artifactId: next.artifacts[0].id, role: "edited" }, T0)).toEqual(
      { ok: false, reason: "run-not-found" }
    );
    expect(linkRunArtifact(next, { runId, artifactId: "ghost", role: "edited" }, T0)).toEqual({
      ok: false,
      reason: "artifact-not-found",
    });
  });

  it("derives a deterministic link id from the relationship", () => {
    expect(agentRunArtifactLinkId("r1", "a1", "edited")).toBe(
      agentRunArtifactLinkId("r1", "a1", "edited")
    );
    expect(agentRunArtifactLinkId("r1", "a1", "edited")).not.toBe(
      agentRunArtifactLinkId("r1", "a1", "inspected")
    );
  });
});

describe("recordArtifactWork", () => {
  it("takes the workspace from the run, not the caller", () => {
    const { state, runId } = seeded("wA");
    const result = recordArtifactWork(
      state,
      { runId, projectPath: PROJECT, path: "src/foo.ts", role: "edited" },
      T0
    );
    if (!result.ok) throw new Error("expected success");

    expect(result.artifact.workspaceId).toBe("wA");
  });

  it("rejects an unknown run", () => {
    const { state } = seeded();

    expect(
      recordArtifactWork(state, { runId: "ghost", projectPath: PROJECT, path: "a.ts", role: "edited" }, T0)
    ).toEqual({ ok: false, reason: "run-not-found" });
  });

  it("rejects an unsafe path", () => {
    const { state, runId } = seeded();

    expect(
      recordArtifactWork(state, { runId, projectPath: PROJECT, path: "../../x", role: "edited" }, T0)
    ).toEqual({ ok: false, reason: "invalid-path" });
  });
});

describe("selectors", () => {
  it("lists a run's artifacts, most recently worked on first", () => {
    const { state, runId } = seeded();
    let next = record(state, runId, "src/old.ts", "edited", T0);
    next = record(next, runId, "src/new.ts", "edited", T0 + 100);

    expect(getArtifactsForRun(next, runId).map((a) => a.relativePath)).toEqual([
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  it("narrows a run's links by role", () => {
    const { state, runId } = seeded();
    let next = record(state, runId, "src/a.ts", "edited");
    next = record(next, runId, "src/b.ts", "inspected");

    expect(getArtifactLinksForRunByRole(next, runId, "edited")).toHaveLength(1);
    expect(getArtifactLinksForRunByRole(next, runId, "inspected")).toHaveLength(1);
    expect(getArtifactLinksForRunByRole(next, runId, "deleted")).toEqual([]);
  });

  it("lists a workspace's artifacts and excludes another workspace's", () => {
    const { state, runId, agentId } = seeded("wA");
    const other = addRun(state, agentId, "wB");

    let next = record(other.state, runId, "src/a.ts");
    next = record(next, other.runId, "src/b.ts");

    expect(getArtifactsForWorkspace(next, "wA").map((a) => a.relativePath)).toEqual(["src/a.ts"]);
    expect(getArtifactsForWorkspace(next, "wB").map((a) => a.relativePath)).toEqual(["src/b.ts"]);
  });

  it("returns nothing for a run with no artifacts", () => {
    const { state, runId } = seeded();

    expect(getArtifactsForRun(state, runId)).toEqual([]);
    expect(getArtifactLinksForRun(state, runId)).toEqual([]);
  });
});

describe("cascade and cleanup", () => {
  it("deleting a run removes its artifact links but keeps the artifact", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    const deleted = deleteRun(next, runId);
    if (!deleted.ok) throw new Error("expected success");

    expect(deleted.state.artifactLinks).toEqual([]);
    // The file itself is still a thing that was worked on.
    expect(deleted.state.artifacts).toHaveLength(1);
  });

  it("a file worked on by two runs survives deleting one of them", () => {
    const { state, runId, agentId } = seeded();
    const second = addRun(state, agentId, "wA");

    let next = record(second.state, runId, "src/foo.ts", "edited");
    next = record(next, second.runId, "src/foo.ts", "inspected");

    const deleted = deleteRun(next, runId);
    if (!deleted.ok) throw new Error("expected success");

    expect(deleted.state.artifacts).toHaveLength(1);
    expect(deleted.state.artifactLinks).toHaveLength(1);
    expect(deleted.state.artifactLinks[0].runId).toBe(second.runId);
  });

  it("collects artifacts nothing refers to any more", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    const deleted = deleteRun(next, runId);
    if (!deleted.ok) throw new Error("expected success");

    expect(pruneOrphanedArtifacts(deleted.state).artifacts).toEqual([]);
  });

  it("leaves referenced artifacts alone when pruning", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    expect(pruneOrphanedArtifacts(next)).toBe(next);
  });

  it("deleting an agent and its runs removes their artifact links", () => {
    const { state, runId, agentId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    const deleted = deleteAgentAndRuns(next, agentId);
    if (!deleted.ok) throw new Error("expected success");

    expect(deleted.state.artifactLinks).toEqual([]);
    expect(pruneOrphanedArtifacts(deleted.state).artifacts).toEqual([]);
  });

  it("removes a run's artifact links on request without touching the run", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");

    const cleared = removeArtifactLinksForRun(next, runId);
    expect(cleared.artifactLinks).toEqual([]);
    expect(cleared.runs).toHaveLength(1);
  });
});

describe("purity", () => {
  it("leaves the input state untouched", () => {
    const { state, runId } = seeded();
    recordArtifactWork(state, { runId, projectPath: PROJECT, path: "src/foo.ts", role: "edited" }, T0);

    expect(state.artifacts).toEqual([]);
    expect(state.artifactLinks).toEqual([]);
  });

  it("stores nothing but metadata", () => {
    const { state, runId } = seeded();
    const next = record(state, runId, "src/foo.ts");
    const artifact = findWorkArtifact(next, next.artifacts[0].id)!;

    expect(Object.keys(artifact).sort()).toEqual([
      "createdAt",
      "id",
      "kind",
      "projectPath",
      "relativePath",
      "updatedAt",
      "workspaceId",
    ]);
  });
});
