import { describe, expect, it } from "vitest";
import { buildAgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import {
  T0,
  withAgent,
  withArtifact,
  withEvent,
  withRun,
  withTabLink,
  withWorkItem,
} from "@/lib/agents/intelligence/__fixtures__/domain";
import { createAgent } from "@/lib/agents/registry";
import { RECENT_RUN_WINDOW_MS } from "@/lib/agents/spatial/types";
import { buildWorldScene } from "@/lib/agents/world/scene";
import { DEFAULT_AGENT_WORLD_SETTINGS } from "@/lib/agents/world/settings";
import { transitionRunStatus } from "@/lib/agents/runs";
import { buildAgentHistory } from "./build";
import type { AgentState } from "@/lib/agents/types";

/**
 * Agent History.
 *
 * The suite's centre of gravity is the divergence from the spatial world: a
 * run that the canvas has stopped drawing must still be an ordinary row
 * here. Several tests assert the two surfaces *disagree*, which is the
 * intended behaviour rather than a bug either of them should fix.
 */

/** Long enough ago that the world will not draw it. */
const LONG_AGO = T0 - RECENT_RUN_WINDOW_MS * 4;
const NOW = T0 + 60_000;

/**
 * Three workspaces, four runs, one of them well outside the world's window.
 *
 * Built through real domain operations, so nothing here is a state the
 * domain could not produce.
 */
function history() {
  const base = withAgent("Claude Code", "claude-code");

  // A second, custom-provider agent. Custom agents must travel the same
  // path as built-in ones — no provider branching anywhere downstream.
  const withCustom = createAgent(
    base.state,
    { provider: "custom:acme", name: "Acme Agent" },
    T0
  );
  if (!withCustom.ok) throw new Error("fixture: custom agent");
  const customId = withCustom.agent.id;

  // 1. The old completed run. The reason this phase exists.
  const old = withRun(
    withCustom.state,
    { agentId: base.agentId, workspaceId: "dev", status: "working", title: "Fix parser imports" },
    LONG_AGO
  );
  const oldItem = withWorkItem(
    old.state,
    { runId: old.runId, title: "Rewrite the import resolver", status: "completed" },
    LONG_AGO
  );
  const oldTabbed = withTabLink(
    oldItem.state,
    { runId: old.runId, tabId: "tab-old", role: "context" },
    LONG_AGO
  );
  const oldFiled = withArtifact(
    oldTabbed,
    { runId: old.runId, path: "src/parser.ts", role: "edited" },
    LONG_AGO
  );
  const oldEvented = withEvent(
    oldFiled.state,
    { runId: old.runId, summary: "Edited parser.ts" },
    LONG_AGO
  );
  const oldFinished = transitionRunStatus(oldEvented, old.runId, "completed", LONG_AGO + 1000);
  if (!oldFinished.ok) throw new Error("fixture: complete old run");

  // 2. A live run, in a different workspace.
  const live = withRun(
    oldFinished.state,
    { agentId: base.agentId, workspaceId: "research", status: "working", title: "Read the spec" },
    T0
  );

  // 3. A recently completed run.
  const recent = withRun(
    live.state,
    { agentId: base.agentId, workspaceId: "dev", status: "working", title: "Tidy the tests" },
    T0
  );
  const recentDone = transitionRunStatus(recent.state, recent.runId, "completed", T0 + 10);
  if (!recentDone.ok) throw new Error("fixture: complete recent run");

  // 4. A custom-agent run, with no title at all.
  const custom = withRun(
    recentDone.state,
    { agentId: customId, workspaceId: "ops", status: "waiting" },
    T0
  );

  const state: AgentState = custom.state;

  return {
    state,
    index: buildAgentDomainIndex(state),
    claudeId: base.agentId,
    customId,
    oldRunId: old.runId,
    liveRunId: live.runId,
    recentRunId: recent.runId,
    customRunId: custom.runId,
  };
}

const NAMES = new Map([
  ["dev", "Development"],
  ["research", "Research"],
  ["ops", "Operations"],
]);

describe("buildAgentHistory", () => {
  it("lists every retained run, across every workspace", () => {
    const h = history();
    const view = buildAgentHistory({ index: h.index, workspaceNames: NAMES });

    expect(view.totalCount).toBe(4);
    expect(new Set(view.entries.map((entry) => entry.runId))).toEqual(
      new Set([h.oldRunId, h.liveRunId, h.recentRunId, h.customRunId])
    );
  });

  /*
    The defining test of the phase. The world and history are asked the same
    question about the same state and must give different answers.
  */
  it("lists a run the spatial world has stopped drawing", () => {
    const h = history();

    const scene = buildWorldScene({
      index: h.index,
      workspaceId: "dev",
      settings: DEFAULT_AGENT_WORLD_SETTINGS,
      now: NOW,
      tabTitles: new Map(),
      idleProviders: [],
    });

    // The canvas does not have it: it completed four windows ago.
    expect(scene.characters.some((character) => character.runId === h.oldRunId)).toBe(false);

    // History does, with its evidence counts intact.
    const view = buildAgentHistory({ index: h.index, workspaceNames: NAMES });
    const entry = view.entries.find((row) => row.runId === h.oldRunId);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("completed");
    expect(entry?.title).toBe("Fix parser imports");
    expect(entry?.workItemCount).toBe(1);
    expect(entry?.artifactCount).toBe(1);
    expect(entry?.tabCount).toBe(1);
    expect(entry?.eventCount).toBeGreaterThan(0);
  });

  it("does not consult a clock at all", () => {
    const h = history();
    // No `now` parameter exists to pass, and the result is identical however
    // long after the fact it is built. A window would make this impossible.
    const first = buildAgentHistory({ index: h.index, workspaceNames: NAMES });
    const second = buildAgentHistory({ index: h.index, workspaceNames: NAMES });
    expect(second).toEqual(first);
  });

  it("includes active and completed runs alike", () => {
    const h = history();
    const view = buildAgentHistory({ index: h.index, workspaceNames: NAMES });
    const byId = new Map(view.entries.map((entry) => [entry.runId, entry]));

    expect(byId.get(h.liveRunId)?.status).toBe("working");
    expect(byId.get(h.recentRunId)?.status).toBe("completed");
    expect(byId.get(h.customRunId)?.status).toBe("waiting");
  });

  it("carries a custom agent with no provider branching", () => {
    const h = history();
    const view = buildAgentHistory({ index: h.index, workspaceNames: NAMES });
    const entry = view.entries.find((row) => row.runId === h.customRunId);

    expect(entry?.provider).toBe("custom:acme");
    expect(entry?.agentName).toBe("Acme Agent");
    expect(entry?.workspaceName).toBe("Operations");
  });

  it("reports a missing title as null rather than inventing one", () => {
    const h = history();
    const view = buildAgentHistory({ index: h.index, workspaceNames: NAMES });
    expect(view.entries.find((row) => row.runId === h.customRunId)?.title).toBeNull();
  });

  it("keeps a run whose workspace the caller did not name", () => {
    const h = history();
    const view = buildAgentHistory({ index: h.index, workspaceNames: new Map() });
    expect(view.totalCount).toBe(4);
    expect(view.entries.every((entry) => entry.workspaceName === null)).toBe(true);
  });

  it("orders newest activity first, deterministically", () => {
    const h = history();
    const view = buildAgentHistory({ index: h.index, workspaceNames: NAMES });

    // The old run is last; it is the only one whose activity predates T0.
    expect(view.entries.at(-1)?.runId).toBe(h.oldRunId);
    expect(buildAgentHistory({ index: h.index, workspaceNames: NAMES }).entries).toEqual(
      view.entries
    );
  });
});

describe("filters", () => {
  it("filters by agent", () => {
    const h = history();
    const view = buildAgentHistory({
      index: h.index,
      workspaceNames: NAMES,
      filter: { agentId: h.customId },
    });

    expect(view.entries.map((entry) => entry.runId)).toEqual([h.customRunId]);
    // The unfiltered total is kept so a view can say "1 of 4".
    expect(view.totalCount).toBe(4);
  });

  it("filters by workspace", () => {
    const h = history();
    const view = buildAgentHistory({
      index: h.index,
      workspaceNames: NAMES,
      filter: { workspaceId: "dev" },
    });
    expect(new Set(view.entries.map((entry) => entry.runId))).toEqual(
      new Set([h.oldRunId, h.recentRunId])
    );
  });

  it("filters by status", () => {
    const h = history();
    const view = buildAgentHistory({
      index: h.index,
      workspaceNames: NAMES,
      filter: { status: "completed" },
    });
    expect(new Set(view.entries.map((entry) => entry.runId))).toEqual(
      new Set([h.oldRunId, h.recentRunId])
    );
  });

  it("combines filters", () => {
    const h = history();
    const view = buildAgentHistory({
      index: h.index,
      workspaceNames: NAMES,
      filter: { workspaceId: "dev", status: "working" },
    });
    expect(view.entries).toEqual([]);
  });

  it("keeps facets unfiltered, so a filter can always be undone", () => {
    const h = history();
    const view = buildAgentHistory({
      index: h.index,
      workspaceNames: NAMES,
      filter: { agentId: h.customId },
    });

    expect(view.agents).toHaveLength(2);
    expect(view.workspaces).toHaveLength(3);
  });
});

describe("degraded records", () => {
  it("keeps a run whose agent is gone, and names no substitute", () => {
    const h = history();
    // Impossible via the registry (it refuses to delete an agent with runs),
    // so it is constructed explicitly: this is the state a partial restore
    // or a hand-edited store can produce.
    const orphaned: AgentState = { ...h.state, agents: [] };
    const view = buildAgentHistory({
      index: buildAgentDomainIndex(orphaned),
      workspaceNames: NAMES,
    });

    expect(view.totalCount).toBe(4);
    expect(view.entries.every((entry) => entry.agentName === null)).toBe(true);
    expect(view.entries.every((entry) => entry.provider === null)).toBe(true);
  });

  it("is empty, not broken, on an empty domain", () => {
    const view = buildAgentHistory({ index: buildAgentDomainIndex(withAgent().state) });
    expect(view).toEqual({ entries: [], totalCount: 0, agents: [], workspaces: [] });
  });
});
