import { describe, expect, it } from "vitest";
import {
  addRunLink,
  agentRunLinkId,
  pruneRunLinks,
  removeLinksForRun,
  removeRunLink,
} from "./links";
import { createAgent } from "./registry";
import { createRun } from "./runs";
import { getRunLinks, getRunLinksByRole, getTabRuns } from "./selectors";
import { emptyAgentState } from "./types";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;

/** Two runs in two different workspaces — the setup every boundary test needs. */
function twoWorkspaces(): {
  state: AgentState;
  runInA: string;
  runInB: string;
} {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "N" }, T0);
  if (!agent.ok) throw new Error("fixture failed");

  const a = createRun(agent.state, { agentId: agent.agent.id, workspaceId: "wA" }, T0);
  if (!a.ok) throw new Error("fixture failed");

  const b = createRun(a.state, { agentId: agent.agent.id, workspaceId: "wB" }, T0);
  if (!b.ok) throw new Error("fixture failed");

  return { state: b.state, runInA: a.run.id, runInB: b.run.id };
}

describe("addRunLink", () => {
  it("links a tab in the run's own workspace", () => {
    const { state, runInA } = twoWorkspaces();
    const result = addRunLink(
      state,
      { runId: runInA, tabId: "t1", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!result.ok) throw new Error("expected success");

    expect(result.created).toBe(true);
    expect(result.link.role).toBe("context");
    expect(result.link.tabId).toBe("t1");
    expect(result.link.createdAt).toBe(T0);
    expect(getRunLinks(result.state, runInA)).toHaveLength(1);
  });

  it("refuses a tab that belongs to a different workspace", () => {
    const { state, runInA } = twoWorkspaces();
    const result = addRunLink(
      state,
      { runId: runInA, tabId: "t-in-b", role: "context", tabWorkspaceId: "wB" },
      T0
    );

    expect(result).toEqual({ ok: false, reason: "cross-workspace" });
    expect(state.links).toEqual([]);
  });

  it("refuses in both directions, so neither workspace can reach the other", () => {
    const { state, runInA, runInB } = twoWorkspaces();

    expect(
      addRunLink(state, { runId: runInA, tabId: "t", role: "produced", tabWorkspaceId: "wB" }, T0)
    ).toEqual({ ok: false, reason: "cross-workspace" });
    expect(
      addRunLink(state, { runId: runInB, tabId: "t", role: "produced", tabWorkspaceId: "wA" }, T0)
    ).toEqual({ ok: false, reason: "cross-workspace" });
  });

  it("is idempotent for the same run, tab and role", () => {
    const { state, runInA } = twoWorkspaces();
    const first = addRunLink(
      state,
      { runId: runInA, tabId: "t1", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!first.ok) throw new Error("expected success");

    const second = addRunLink(
      first.state,
      { runId: runInA, tabId: "t1", role: "context", tabWorkspaceId: "wA" },
      T0 + 999
    );
    if (!second.ok) throw new Error("expected success");

    expect(second.created).toBe(false);
    expect(second.state).toBe(first.state);
    expect(second.link.createdAt).toBe(T0);
    expect(getRunLinks(second.state, runInA)).toHaveLength(1);
  });

  it("treats a different role for the same tab as a separate link", () => {
    const { state, runInA } = twoWorkspaces();
    const context = addRunLink(
      state,
      { runId: runInA, tabId: "t1", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!context.ok) throw new Error("expected success");

    const produced = addRunLink(
      context.state,
      { runId: runInA, tabId: "t1", role: "produced", tabWorkspaceId: "wA" },
      T0
    );
    if (!produced.ok) throw new Error("expected success");

    expect(produced.created).toBe(true);
    expect(getRunLinks(produced.state, runInA)).toHaveLength(2);
    expect(getRunLinksByRole(produced.state, runInA, "produced")).toHaveLength(1);
  });

  it("rejects an unknown run and blank identifiers", () => {
    const { state, runInA } = twoWorkspaces();

    expect(
      addRunLink(state, { runId: "ghost", tabId: "t", role: "context", tabWorkspaceId: "wA" }, T0)
    ).toEqual({ ok: false, reason: "run-not-found" });
    expect(
      addRunLink(state, { runId: runInA, tabId: "  ", role: "context", tabWorkspaceId: "wA" }, T0)
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      addRunLink(state, { runId: runInA, tabId: "t", role: "context", tabWorkspaceId: " " }, T0)
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("derives a deterministic id from the relationship itself", () => {
    expect(agentRunLinkId("r1", "t1", "context")).toBe(agentRunLinkId("r1", "t1", "context"));
    expect(agentRunLinkId("r1", "t1", "context")).not.toBe(agentRunLinkId("r1", "t1", "produced"));
    expect(agentRunLinkId("r1", "t1", "context")).not.toBe(agentRunLinkId("r2", "t1", "context"));
  });
});

describe("removing links", () => {
  function linked() {
    const { state, runInA, runInB } = twoWorkspaces();
    const first = addRunLink(
      state,
      { runId: runInA, tabId: "t1", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!first.ok) throw new Error("fixture failed");

    const second = addRunLink(
      first.state,
      { runId: runInA, tabId: "t2", role: "produced", tabWorkspaceId: "wA" },
      T0
    );
    if (!second.ok) throw new Error("fixture failed");

    const other = addRunLink(
      second.state,
      { runId: runInB, tabId: "t3", role: "context", tabWorkspaceId: "wB" },
      T0
    );
    if (!other.ok) throw new Error("fixture failed");

    return { state: other.state, runInA, runInB, linkId: first.link.id };
  }

  it("removes one link by id", () => {
    const { state, runInA, linkId } = linked();
    const result = removeRunLink(state, linkId);

    expect(getRunLinks(result.state, runInA)).toHaveLength(1);
  });

  it("treats removing an absent link as success", () => {
    const { state } = linked();

    expect(removeRunLink(state, "not-a-link").state.links).toHaveLength(3);
  });

  it("removes every link for one run without touching another run's", () => {
    const { state, runInA, runInB } = linked();
    const result = removeLinksForRun(state, runInA);

    expect(getRunLinks(result.state, runInA)).toEqual([]);
    expect(getRunLinks(result.state, runInB)).toHaveLength(1);
  });
});

describe("pruneRunLinks", () => {
  it("drops links whose tab no longer exists", () => {
    const { state, runInA } = twoWorkspaces();
    const a = addRunLink(
      state,
      { runId: runInA, tabId: "alive", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!a.ok) throw new Error("fixture failed");

    const b = addRunLink(
      a.state,
      { runId: runInA, tabId: "deleted", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!b.ok) throw new Error("fixture failed");

    const pruned = pruneRunLinks(b.state, new Set(["alive"]));

    expect(pruned.links.map((l) => l.tabId)).toEqual(["alive"]);
  });

  it("returns the same state when nothing needs pruning", () => {
    const { state, runInA } = twoWorkspaces();
    const a = addRunLink(
      state,
      { runId: runInA, tabId: "alive", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!a.ok) throw new Error("fixture failed");

    expect(pruneRunLinks(a.state, new Set(["alive"]))).toBe(a.state);
  });
});

describe("reverse lookup", () => {
  it("finds the runs that touched a tab", () => {
    const { state, runInA } = twoWorkspaces();
    const a = addRunLink(
      state,
      { runId: runInA, tabId: "t1", role: "context", tabWorkspaceId: "wA" },
      T0
    );
    if (!a.ok) throw new Error("fixture failed");

    expect(getTabRuns(a.state, "t1").map((r) => r.id)).toEqual([runInA]);
    expect(getTabRuns(a.state, "unlinked")).toEqual([]);
  });
});
