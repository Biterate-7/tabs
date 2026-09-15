import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { namespacedKey, scopedKey, setStorageNamespace } from "@/lib/storage/namespace";
import {
  AGENT_STORAGE_KEY,
  defaultAgentState,
  loadAgentState,
  saveAgentState,
} from "./persistence";
import { appendRunEvent } from "./events";
import { addRunLink } from "./links";
import { createAgent } from "./registry";
import { createRun } from "./runs";
import { AGENT_STATE_VERSION, MAX_EVENTS_PER_RUN, emptyAgentState } from "./types";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

/** A populated domain: one agent, one run, one link, one event. */
function populated(workspaceId = "w1"): AgentState {
  const agent = createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");

  const run = createRun(
    agent.state,
    { agentId: agent.agent.id, workspaceId, externalId: "sess-1", title: "Add auth" },
    T0
  );
  if (!run.ok) throw new Error("fixture failed");

  const linked = addRunLink(
    run.state,
    { runId: run.run.id, tabId: "t1", role: "context", tabWorkspaceId: workspaceId },
    T0
  );
  if (!linked.ok) throw new Error("fixture failed");

  const evented = appendRunEvent(linked.state, {
    runId: run.run.id,
    kind: "activity",
    summary: "Edited app-sidebar.tsx",
    sourceId: "toolu_1",
    timestamp: T0 + 5,
  });
  if (!evented.ok) throw new Error("fixture failed");

  return evented.state;
}

function writeRaw(value: unknown): void {
  window.localStorage.setItem(scopedKey(AGENT_STORAGE_KEY), JSON.stringify(value));
}

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

describe("round trip", () => {
  it("returns an empty domain when nothing is stored", () => {
    const load = loadAgentState();

    expect(load.status).toBe("empty");
    expect(load.state).toEqual(defaultAgentState());
  });

  it("saves and reloads a populated domain intact", () => {
    const state = populated();
    expect(saveAgentState(state)).toBe(true);

    const load = loadAgentState();
    expect(load.status).toBe("loaded");
    expect(load.state).toEqual(state);
  });

  it("preserves run metadata and event source ids across a reload", () => {
    saveAgentState(populated());
    const { state } = loadAgentState();

    expect(state.runs[0].externalId).toBe("sess-1");
    expect(state.runs[0].title).toBe("Add auth");
    expect(state.events[0].sourceId).toBe("toolu_1");
    expect(state.links[0].role).toBe("context");
  });
});

describe("schema version", () => {
  it("ignores state with no version", () => {
    writeRaw({ agents: [], runs: [], links: [], events: [] });

    expect(loadAgentState().status).toBe("empty");
  });

  it("reports a newer version as unsupported rather than adopting it", () => {
    writeRaw({ version: AGENT_STATE_VERSION + 1, agents: [], runs: [], links: [], events: [] });
    const load = loadAgentState();

    expect(load.status).toBe("unsupported");
    expect(load.state).toEqual(defaultAgentState());
  });

  it("leaves newer state on disk, so an older build cannot destroy it", () => {
    const future = { version: AGENT_STATE_VERSION + 1, agents: [], runs: [], links: [], events: [] };
    writeRaw(future);

    loadAgentState();

    expect(JSON.parse(window.localStorage.getItem(scopedKey(AGENT_STORAGE_KEY))!)).toEqual(future);
  });
});

describe("corrupt and hostile state", () => {
  it("survives unparseable JSON", () => {
    window.localStorage.setItem(scopedKey(AGENT_STORAGE_KEY), "{not json");

    expect(loadAgentState().status).toBe("empty");
  });

  it("survives a non-object payload", () => {
    writeRaw("just a string");

    expect(loadAgentState().status).toBe("empty");
  });

  it("survives arrays that are not arrays", () => {
    writeRaw({ version: 1, agents: "nope", runs: 7, links: null, events: undefined });
    const load = loadAgentState();

    expect(load.status).toBe("loaded");
    expect(load.state).toEqual(defaultAgentState());
  });

  it("drops malformed agents but keeps the good ones", () => {
    writeRaw({
      version: 1,
      agents: [
        { id: "a1", provider: "p", name: "Good", createdAt: T0, updatedAt: T0 },
        { id: "a2", provider: "", name: "No provider", createdAt: T0 },
        { id: "a3", name: "No provider key", createdAt: T0 },
        { provider: "p", name: "No id", createdAt: T0 },
        { id: "a4", provider: "p", name: "Bad clock", createdAt: "yesterday" },
        null,
        "nonsense",
      ],
      runs: [],
      links: [],
      events: [],
    });

    expect(loadAgentState().state.agents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("drops duplicate ids, keeping the first", () => {
    writeRaw({
      version: 1,
      agents: [
        { id: "a1", provider: "p", name: "First", createdAt: T0 },
        { id: "a1", provider: "p", name: "Second", createdAt: T0 },
      ],
      runs: [],
      links: [],
      events: [],
    });

    const agents = loadAgentState().state.agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("First");
  });

  it("defaults a missing updatedAt to createdAt rather than epoch zero", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [],
      links: [],
      events: [],
    });

    expect(loadAgentState().state.agents[0].updatedAt).toBe(T0);
  });

  it("drops runs with an unknown status or a missing workspace", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [
        { id: "r1", agentId: "a1", workspaceId: "w1", status: "working", createdAt: T0 },
        { id: "r2", agentId: "a1", workspaceId: "w1", status: "exploded", createdAt: T0 },
        { id: "r3", agentId: "a1", workspaceId: "", status: "working", createdAt: T0 },
      ],
      links: [],
      events: [],
    });

    expect(loadAgentState().state.runs.map((r) => r.id)).toEqual(["r1"]);
  });

  it("drops runs whose agent is gone, rather than keeping an unreachable ghost", () => {
    writeRaw({
      version: 1,
      agents: [],
      runs: [{ id: "r1", agentId: "missing", workspaceId: "w1", status: "working", createdAt: T0 }],
      links: [],
      events: [],
    });

    expect(loadAgentState().state.runs).toEqual([]);
  });

  it("drops links and events whose run is gone", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [],
      links: [{ id: "l1", runId: "missing", tabId: "t1", role: "context", createdAt: T0 }],
      events: [{ id: "e1", runId: "missing", timestamp: T0, kind: "activity", summary: "x" }],
    });

    const { state } = loadAgentState();
    expect(state.links).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("drops links with an unrecognised role", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [{ id: "r1", agentId: "a1", workspaceId: "w1", status: "working", createdAt: T0 }],
      links: [
        { id: "l1", runId: "r1", tabId: "t1", role: "context", createdAt: T0 },
        { id: "l2", runId: "r1", tabId: "t2", role: "summoned", createdAt: T0 },
      ],
      events: [],
    });

    expect(loadAgentState().state.links.map((l) => l.id)).toEqual(["l1"]);
  });

  it("drops events with an unrecognised kind or an empty summary", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [{ id: "r1", agentId: "a1", workspaceId: "w1", status: "working", createdAt: T0 }],
      links: [],
      events: [
        { id: "e1", runId: "r1", timestamp: T0, kind: "activity", summary: "Good" },
        { id: "e2", runId: "r1", timestamp: T0, kind: "telepathy", summary: "Bad kind" },
        { id: "e3", runId: "r1", timestamp: T0, kind: "activity", summary: "   " },
        { id: "e4", runId: "r1", timestamp: Number.NaN, kind: "activity", summary: "Bad clock" },
      ],
    });

    expect(loadAgentState().state.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("reconciles endedAt against terminality in both directions", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [
        // Terminal but missing its timestamp.
        { id: "r1", agentId: "a1", workspaceId: "w1", status: "completed", createdAt: T0, updatedAt: T0 + 9 },
        // Live, but carrying a stale endedAt.
        { id: "r2", agentId: "a1", workspaceId: "w1", status: "working", createdAt: T0, endedAt: T0 + 5 },
      ],
      links: [],
      events: [],
    });

    const runs = loadAgentState().state.runs;
    expect(runs.find((r) => r.id === "r1")?.endedAt).toBe(T0 + 9);
    expect(runs.find((r) => r.id === "r2")?.endedAt).toBeUndefined();
  });

  it("re-applies the per-run event cap to oversized stored state", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [{ id: "r1", agentId: "a1", workspaceId: "w1", status: "working", createdAt: T0 }],
      links: [],
      events: Array.from({ length: MAX_EVENTS_PER_RUN + 40 }, (_, i) => ({
        id: `e${i}`,
        runId: "r1",
        timestamp: T0 + i,
        kind: "activity",
        summary: `Event ${i}`,
      })),
    });

    const events = loadAgentState().state.events;
    expect(events).toHaveLength(MAX_EVENTS_PER_RUN);
    expect(events.map((e) => e.summary)).not.toContain("Event 0");
  });
});

describe("account isolation", () => {
  it("keeps each account's agent domain to itself", () => {
    setStorageNamespace(ADA);
    saveAgentState(populated("ada-workspace"));

    setStorageNamespace(GRACE);
    expect(loadAgentState().state.agents).toEqual([]);

    saveAgentState(populated("grace-workspace"));
    expect(loadAgentState().state.runs[0].workspaceId).toBe("grace-workspace");

    setStorageNamespace(ADA);
    expect(loadAgentState().state.runs[0].workspaceId).toBe("ada-workspace");
  });

  it("hides the signed-out domain from a signed-in account", () => {
    saveAgentState(populated("anon-workspace"));

    setStorageNamespace(ADA);
    expect(loadAgentState().status).toBe("empty");
  });

  it("gives the signed-out domain back after signing out", () => {
    saveAgentState(populated("anon-workspace"));

    setStorageNamespace(ADA);
    saveAgentState(populated("ada-workspace"));

    setStorageNamespace(null);
    expect(loadAgentState().state.runs[0].workspaceId).toBe("anon-workspace");
  });

  it("writes under the account-prefixed key, not the bare one", () => {
    setStorageNamespace(ADA);
    saveAgentState(populated());

    expect(window.localStorage.getItem(namespacedKey(AGENT_STORAGE_KEY, ADA))).toBeTruthy();
    expect(window.localStorage.getItem(AGENT_STORAGE_KEY)).toBeNull();
  });
});

describe("saveAgentState", () => {
  it("reports failure instead of throwing when storage refuses", () => {
    // Stubbed on the prototype, which is where jsdom actually implements it —
    // assigning to the instance would leave the real method in place.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    try {
      expect(saveAgentState(populated())).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("artifact persistence", () => {
  const PROJECT = "C:\\repo\\project";

  function artifactRecord(over: Record<string, unknown> = {}) {
    const workspaceId = "w1";
    const relativePath = "src/foo.ts";
    return {
      id: `wa-${workspaceId}::c:/repo/project::${relativePath}`,
      workspaceId,
      projectPath: PROJECT,
      relativePath,
      kind: "file",
      createdAt: T0,
      updatedAt: T0,
      ...over,
    };
  }

  function withArtifacts(artifacts: unknown[], artifactLinks: unknown[] = []) {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [{ id: "r1", agentId: "a1", workspaceId: "w1", status: "working", createdAt: T0 }],
      links: [],
      events: [],
      artifacts,
      artifactLinks,
    });
  }

  it("defaults to empty for state written before artifacts existed", () => {
    writeRaw({
      version: 1,
      agents: [{ id: "a1", provider: "p", name: "N", createdAt: T0 }],
      runs: [],
      links: [],
      events: [],
    });

    const { state, status } = loadAgentState();
    expect(status).toBe("loaded");
    expect(state.artifacts).toEqual([]);
    expect(state.artifactLinks).toEqual([]);
    // The pre-existing agent is untouched by the upgrade.
    expect(state.agents).toHaveLength(1);
  });

  it("loads a well-formed artifact", () => {
    withArtifacts([artifactRecord()]);

    expect(loadAgentState().state.artifacts).toHaveLength(1);
  });

  it("drops an artifact whose id does not match its own contents", () => {
    withArtifacts([artifactRecord({ id: "wa-tampered" })]);

    expect(loadAgentState().state.artifacts).toEqual([]);
  });

  it("drops an artifact whose stored path escapes its project", () => {
    withArtifacts([
      artifactRecord({
        relativePath: "../../secret.txt",
        id: "wa-w1::c:/repo/project::../../secret.txt",
      }),
    ]);

    expect(loadAgentState().state.artifacts).toEqual([]);
  });

  it("drops an artifact whose stored path is absolute", () => {
    withArtifacts([
      artifactRecord({
        relativePath: "C:\\elsewhere\\secret.txt",
        id: "wa-w1::c:/repo/project::C:\\elsewhere\\secret.txt",
      }),
    ]);

    expect(loadAgentState().state.artifacts).toEqual([]);
  });

  it("drops artifacts with an unknown kind or missing fields", () => {
    withArtifacts([
      artifactRecord({ kind: "database" }),
      artifactRecord({ id: "wa-2", workspaceId: "" }),
      artifactRecord({ id: "wa-3", createdAt: "yesterday" }),
      null,
      "nonsense",
    ]);

    expect(loadAgentState().state.artifacts).toEqual([]);
  });

  it("drops duplicate artifact ids, keeping the first", () => {
    withArtifacts([artifactRecord(), artifactRecord({ updatedAt: T0 + 999 })]);

    const artifacts = loadAgentState().state.artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].updatedAt).toBe(T0);
  });

  it("loads a well-formed artifact link", () => {
    const artifact = artifactRecord();
    withArtifacts(
      [artifact],
      [{ id: "ara-1", runId: "r1", artifactId: artifact.id, role: "edited", createdAt: T0 }]
    );

    expect(loadAgentState().state.artifactLinks).toHaveLength(1);
  });

  it("drops links whose run or artifact is gone", () => {
    const artifact = artifactRecord();
    withArtifacts(
      [artifact],
      [
        { id: "ara-1", runId: "missing", artifactId: artifact.id, role: "edited", createdAt: T0 },
        { id: "ara-2", runId: "r1", artifactId: "missing", role: "edited", createdAt: T0 },
      ]
    );

    expect(loadAgentState().state.artifactLinks).toEqual([]);
  });

  it("drops links with an unrecognised role", () => {
    const artifact = artifactRecord();
    withArtifacts(
      [artifact],
      [{ id: "ara-1", runId: "r1", artifactId: artifact.id, role: "summoned", createdAt: T0 }]
    );

    expect(loadAgentState().state.artifactLinks).toEqual([]);
  });

  it("drops a link that crosses a workspace boundary", () => {
    // The run lives in w1; this artifact claims w2.
    const foreign = artifactRecord({
      workspaceId: "w2",
      id: "wa-w2::c:/repo/project::src/foo.ts",
    });
    withArtifacts(
      [foreign],
      [{ id: "ara-1", runId: "r1", artifactId: foreign.id, role: "edited", createdAt: T0 }]
    );

    expect(loadAgentState().state.artifactLinks).toEqual([]);
  });
});
