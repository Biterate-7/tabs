import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { ingestObservation } from "./adapter";
import { workArtifactId } from "./artifacts";
import { loadAgentState, saveAgentState } from "./persistence";
import { createAgent } from "./registry";
import { findRunByExternalId } from "./runs";
import {
  getArtifactLinksForRun,
  getArtifactRoles,
  getArtifactsForRun,
  getArtifactsForWorkspace,
} from "./selectors";
import { emptyAgentState } from "./types";
import type { AgentAdapterObservation, AgentArtifactObservation } from "./adapter";
import type { AgentState } from "./types";

/**
 * The provider-neutral ingestion path: an observation carrying file work
 * becomes an artifact and a relationship, through the same seam every
 * provider uses.
 */

const T0 = 1_700_000_000_000;
const PROJECT = "C:\\repo\\project";
const SESSION = "sess-1";
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

function seeded(): { state: AgentState; agentId: string } {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "N" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  return { state: agent.state, agentId: agent.agent.id };
}

function observation(over: Partial<AgentAdapterObservation> = {}): AgentAdapterObservation {
  return { provider: "p", externalId: SESSION, workspaceId: "wA", ...over };
}

function artifact(
  relativePath: string,
  role: AgentArtifactObservation["role"] = "edited",
  sourceId?: string
): AgentArtifactObservation {
  return { projectPath: PROJECT, relativePath, role, sourceId };
}

function ingest(
  state: AgentState,
  agentId: string,
  obs: AgentAdapterObservation,
  now = T0
): AgentState {
  const result = ingestObservation(state, { agentId, observation: obs, now });
  if (!result.ok) throw new Error(`ingest failed: ${result.reason}`);
  return result.state;
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

describe("the full ingestion sequence", () => {
  it("turns an observation into a run, an artifact and a link", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({ activity: "Edited foo.ts", artifacts: [artifact("src/foo.ts")] })
    );

    const run = findRunByExternalId(next, agentId, SESSION)!;
    expect(run).toBeDefined();

    const artifacts = getArtifactsForRun(next, run.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].relativePath).toBe("src/foo.ts");
    expect(artifacts[0].workspaceId).toBe("wA");
    expect(getArtifactLinksForRun(next, run.id)[0].role).toBe("edited");
  });

  it("records artifacts on the very first observation, which also creates the run", () => {
    const { state, agentId } = seeded();
    const next = ingest(state, agentId, observation({ artifacts: [artifact("src/foo.ts")] }));

    expect(next.runs).toHaveLength(1);
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactLinks).toHaveLength(1);
  });

  it("records several files from one observation", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({
        artifacts: [artifact("src/a.ts"), artifact("src/b.ts"), artifact("package.json")],
      })
    );

    const run = findRunByExternalId(next, agentId, SESSION)!;
    expect(getArtifactsForRun(next, run.id).map((a) => a.relativePath).sort()).toEqual([
      "package.json",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("records different roles for the same file", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({
        artifacts: [artifact("src/foo.ts", "inspected"), artifact("src/foo.ts", "edited")],
      })
    );

    const run = findRunByExternalId(next, agentId, SESSION)!;
    expect(next.artifacts).toHaveLength(1);
    expect(getArtifactRoles(next, run.id, next.artifacts[0].id).sort()).toEqual([
      "edited",
      "inspected",
    ]);
  });
});

describe("deduplication", () => {
  it("does not duplicate artifacts or links across repeated polls", () => {
    const { state, agentId } = seeded();
    const obs = observation({ artifacts: [artifact("src/foo.ts", "edited", "toolu_1")] });

    let next = state;
    for (let i = 0; i < 5; i += 1) next = ingest(next, agentId, obs, T0 + i);

    expect(next.runs).toHaveLength(1);
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactLinks).toHaveLength(1);
  });

  it("collapses the same file named twice in one observation", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({ artifacts: [artifact("src/foo.ts"), artifact("src/foo.ts")] })
    );

    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactLinks).toHaveLength(1);
  });

  it("treats an absolute and a relative spelling of one file as the same artifact", () => {
    const { state, agentId } = seeded();
    let next = ingest(state, agentId, observation({ artifacts: [artifact("src/foo.ts")] }));
    next = ingest(
      next,
      agentId,
      observation({
        artifacts: [
          { projectPath: PROJECT, relativePath: "C:\\repo\\project\\src\\foo.ts", role: "edited" },
        ],
      }),
      T0 + 10
    );

    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactLinks).toHaveLength(1);
  });

  it("keeps one artifact when two runs touch the same file", () => {
    const { state, agentId } = seeded();
    let next = ingest(state, agentId, observation({ artifacts: [artifact("src/foo.ts")] }));
    next = ingest(
      next,
      agentId,
      observation({ externalId: "sess-2", artifacts: [artifact("src/foo.ts", "inspected")] }),
      T0 + 10
    );

    expect(next.runs).toHaveLength(2);
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactLinks).toHaveLength(2);
  });
});

describe("rejections leave the rest of the observation intact", () => {
  it("drops an artifact whose path escapes the project", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({
        activity: "Did something",
        artifacts: [artifact("../../secret.txt"), artifact("src/ok.ts")],
      })
    );

    expect(next.artifacts.map((a) => a.relativePath)).toEqual(["src/ok.ts"]);
    // The run and its activity survived.
    expect(next.runs).toHaveLength(1);
    expect(next.events.some((e) => e.summary === "Did something")).toBe(true);
  });

  it("drops an artifact under a different root", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({
        artifacts: [
          { projectPath: PROJECT, relativePath: "C:\\elsewhere\\secret.txt", role: "edited" },
        ],
      })
    );

    expect(next.artifacts).toEqual([]);
  });

  it("drops an artifact with a missing project or path", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({
        artifacts: [
          { projectPath: "", relativePath: "src/a.ts", role: "edited" },
          { projectPath: PROJECT, relativePath: "  ", role: "edited" },
        ],
      })
    );

    expect(next.artifacts).toEqual([]);
  });

  it("creates no artifact when the observation has no workspace", () => {
    const { state, agentId } = seeded();
    const result = ingestObservation(state, {
      agentId,
      observation: { provider: "p", externalId: SESSION, artifacts: [artifact("src/foo.ts")] },
      now: T0,
    });
    if (!result.ok) throw new Error("expected success");

    // Unattached: no run, and therefore nothing to attach a file to.
    expect(result.outcome).toBe("unattached");
    expect(result.state.artifacts).toEqual([]);
    expect(result.state.artifactLinks).toEqual([]);
  });

  it("ignores an empty artifact list", () => {
    const { state, agentId } = seeded();
    const next = ingest(state, agentId, observation({ artifacts: [] }));

    expect(next.artifacts).toEqual([]);
    expect(next.runs).toHaveLength(1);
  });
});

describe("workspace boundary", () => {
  it("files an artifact in the run's workspace, not another", () => {
    const { state, agentId } = seeded();
    let next = ingest(state, agentId, observation({ artifacts: [artifact("src/foo.ts")] }));
    next = ingest(
      next,
      agentId,
      observation({
        externalId: "sess-b",
        workspaceId: "wB",
        artifacts: [artifact("src/foo.ts")],
      }),
      T0 + 5
    );

    expect(getArtifactsForWorkspace(next, "wA")).toHaveLength(1);
    expect(getArtifactsForWorkspace(next, "wB")).toHaveLength(1);
    // Same file path, two workspaces, two distinct artifacts.
    expect(next.artifacts).toHaveLength(2);
    expect(next.artifacts[0].id).not.toBe(next.artifacts[1].id);
  });

  it("never links a run to an artifact outside its workspace", () => {
    const { state, agentId } = seeded();
    let next = ingest(state, agentId, observation({ artifacts: [artifact("src/foo.ts")] }));
    next = ingest(
      next,
      agentId,
      observation({ externalId: "sess-b", workspaceId: "wB", artifacts: [artifact("src/foo.ts")] }),
      T0 + 5
    );

    for (const link of next.artifactLinks) {
      const run = next.runs.find((r) => r.id === link.runId)!;
      const found = next.artifacts.find((a) => a.id === link.artifactId)!;
      expect(run.workspaceId).toBe(found.workspaceId);
    }
  });
});

describe("persistence round trip", () => {
  it("survives a reload with identity, role and workspace intact", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({
        artifacts: [artifact("src/foo.ts", "edited"), artifact("src/bar.ts", "inspected")],
      })
    );

    expect(saveAgentState(next)).toBe(true);
    const reloaded = loadAgentState();

    expect(reloaded.status).toBe("loaded");
    expect(reloaded.state.artifacts).toHaveLength(2);
    expect(reloaded.state.artifactLinks).toHaveLength(2);

    const run = findRunByExternalId(reloaded.state, agentId, SESSION)!;
    const artifacts = getArtifactsForRun(reloaded.state, run.id);
    expect(artifacts.map((a) => a.relativePath).sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
    expect(artifacts[0].workspaceId).toBe("wA");

    const roles = getArtifactLinksForRun(reloaded.state, run.id).map((l) => l.role).sort();
    expect(roles).toEqual(["edited", "inspected"]);
  });

  it("re-resolves to the same artifact after a reload", () => {
    const { state, agentId } = seeded();
    const next = ingest(state, agentId, observation({ artifacts: [artifact("src/foo.ts")] }));
    saveAgentState(next);

    const reloaded = loadAgentState().state;
    const after = ingest(reloaded, agentId, observation({ artifacts: [artifact("src/foo.ts")] }), T0 + 50);

    expect(after.artifacts).toHaveLength(1);
    expect(after.artifacts[0].id).toBe(workArtifactId("wA", PROJECT, "src/foo.ts"));
  });
});

describe("account isolation", () => {
  it("keeps one account's artifacts and links invisible to another", () => {
    setStorageNamespace(ADA);
    const ada = seeded();
    saveAgentState(
      ingest(ada.state, ada.agentId, observation({ workspaceId: "ada-w", artifacts: [artifact("src/ada.ts")] }))
    );

    setStorageNamespace(GRACE);
    expect(loadAgentState().state.artifacts).toEqual([]);
    expect(loadAgentState().state.artifactLinks).toEqual([]);

    const grace = seeded();
    saveAgentState(
      ingest(
        grace.state,
        grace.agentId,
        observation({ workspaceId: "grace-w", artifacts: [artifact("src/grace.ts")] })
      )
    );
    expect(loadAgentState().state.artifacts[0].relativePath).toBe("src/grace.ts");

    setStorageNamespace(ADA);
    const back = loadAgentState().state;
    expect(back.artifacts).toHaveLength(1);
    expect(back.artifacts[0].relativePath).toBe("src/ada.ts");
    expect(back.artifacts[0].workspaceId).toBe("ada-w");
  });
});

describe("what artifacts do and do not carry", () => {
  it("stores path metadata and nothing resembling content", () => {
    const { state, agentId } = seeded();
    const next = ingest(
      state,
      agentId,
      observation({ activity: "Edited foo.ts", artifacts: [artifact("src/foo.ts")] })
    );

    const serialized = JSON.stringify(next.artifacts);
    expect(serialized).toContain("src/foo.ts");
    for (const key of ["content", "body", "diff", "source", "text", "hash", "size"]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });
});
