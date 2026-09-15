import { describe, expect, it } from "vitest";
import {
  createAgent,
  deleteAgent,
  deleteAgentAndRuns,
  findAgent,
  findAgentByProvider,
  listAgents,
  updateAgent,
} from "./registry";
import { appendRunEvent } from "./events";
import { addRunLink } from "./links";
import { createRun } from "./runs";
import { emptyAgentState } from "./types";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;

function withAgent(name = "Claude Code", provider = "claude-code") {
  const created = createAgent(emptyAgentState(), { provider, name }, T0);
  if (!created.ok) throw new Error(`fixture failed: ${created.reason}`);
  return { state: created.state, agent: created.agent };
}

describe("createAgent", () => {
  it("mints an identity with matching create/update timestamps", () => {
    const { agent } = withAgent();

    expect(agent.provider).toBe("claude-code");
    expect(agent.name).toBe("Claude Code");
    expect(agent.createdAt).toBe(T0);
    expect(agent.updatedAt).toBe(T0);
    expect(agent.id).toBeTruthy();
  });

  it("rejects a blank provider or name rather than storing an unusable identity", () => {
    const state = emptyAgentState();

    expect(createAgent(state, { provider: "  ", name: "X" }, T0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(createAgent(state, { provider: "x", name: "   " }, T0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("trims surrounding whitespace", () => {
    const created = createAgent(emptyAgentState(), { provider: " p ", name: " N " }, T0);
    if (!created.ok) throw new Error("expected success");

    expect(created.agent.provider).toBe("p");
    expect(created.agent.name).toBe("N");
  });

  it("leaves the input state untouched", () => {
    const state = emptyAgentState();
    createAgent(state, { provider: "p", name: "N" }, T0);

    expect(state.agents).toEqual([]);
  });

  it("gives two agents distinct ids", () => {
    const first = withAgent();
    const second = createAgent(first.state, { provider: "claude-code", name: "Other" }, T0);
    if (!second.ok) throw new Error("expected success");

    expect(second.agent.id).not.toBe(first.agent.id);
    expect(listAgents(second.state)).toHaveLength(2);
  });
});

describe("reading agents", () => {
  it("finds by id and by provider", () => {
    const { state, agent } = withAgent();

    expect(findAgent(state, agent.id)).toEqual(agent);
    expect(findAgentByProvider(state, "claude-code")).toEqual(agent);
  });

  it("returns undefined for ids and providers it does not have", () => {
    const { state } = withAgent();

    expect(findAgent(state, "nope")).toBeUndefined();
    expect(findAgentByProvider(state, "cursor")).toBeUndefined();
  });
});

describe("updateAgent", () => {
  it("renames and bumps updatedAt only", () => {
    const { state, agent } = withAgent();
    const result = updateAgent(state, agent.id, { name: "Renamed" }, T0 + 500);
    if (!result.ok) throw new Error("expected success");

    expect(result.agent.name).toBe("Renamed");
    expect(result.agent.updatedAt).toBe(T0 + 500);
    expect(result.agent.createdAt).toBe(T0);
  });

  it("treats a no-op rename as success without touching updatedAt", () => {
    const { state, agent } = withAgent();
    const result = updateAgent(state, agent.id, { name: "Claude Code" }, T0 + 500);
    if (!result.ok) throw new Error("expected success");

    expect(result.state).toBe(state);
    expect(result.agent.updatedAt).toBe(T0);
  });

  it("rejects an unknown agent and a blank name", () => {
    const { state, agent } = withAgent();

    expect(updateAgent(state, "nope", { name: "X" }, T0)).toEqual({
      ok: false,
      reason: "agent-not-found",
    });
    expect(updateAgent(state, agent.id, { name: "  " }, T0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });
});

describe("deleteAgent", () => {
  it("removes an agent that has no runs", () => {
    const { state, agent } = withAgent();
    const result = deleteAgent(state, agent.id);
    if (!result.ok) throw new Error("expected success");

    expect(result.state.agents).toEqual([]);
  });

  it("refuses while runs exist, rather than orphaning them", () => {
    const { state, agent } = withAgent();
    const run = createRun(state, { agentId: agent.id, workspaceId: "w1" }, T0);
    if (!run.ok) throw new Error("expected success");

    expect(deleteAgent(run.state, agent.id)).toEqual({ ok: false, reason: "agent-has-runs" });
    expect(run.state.agents).toHaveLength(1);
    expect(run.state.runs).toHaveLength(1);
  });

  it("rejects an unknown agent", () => {
    expect(deleteAgent(emptyAgentState(), "nope")).toEqual({
      ok: false,
      reason: "agent-not-found",
    });
  });
});

describe("deleteAgentAndRuns", () => {
  function populated(): { state: AgentState; agentId: string; otherAgentId: string } {
    const { state: s1, agent } = withAgent();
    const other = createAgent(s1, { provider: "other", name: "Other" }, T0);
    if (!other.ok) throw new Error("fixture failed");

    const doomed = createRun(other.state, { agentId: agent.id, workspaceId: "w1" }, T0);
    if (!doomed.ok) throw new Error("fixture failed");

    const survivor = createRun(
      doomed.state,
      { agentId: other.agent.id, workspaceId: "w1" },
      T0
    );
    if (!survivor.ok) throw new Error("fixture failed");

    const linked = addRunLink(
      survivor.state,
      { runId: doomed.run.id, tabId: "t1", role: "context", tabWorkspaceId: "w1" },
      T0
    );
    if (!linked.ok) throw new Error("fixture failed");

    const evented = appendRunEvent(linked.state, {
      runId: doomed.run.id,
      kind: "activity",
      summary: "Edited a file",
      timestamp: T0,
    });
    if (!evented.ok) throw new Error("fixture failed");

    const survivorEvent = appendRunEvent(evented.state, {
      runId: survivor.run.id,
      kind: "activity",
      summary: "Untouched",
      timestamp: T0,
    });
    if (!survivorEvent.ok) throw new Error("fixture failed");

    return { state: survivorEvent.state, agentId: agent.id, otherAgentId: other.agent.id };
  }

  it("cascades to the agent's runs, links and events", () => {
    const { state, agentId } = populated();
    const result = deleteAgentAndRuns(state, agentId);
    if (!result.ok) throw new Error("expected success");

    expect(result.state.agents.map((a) => a.id)).not.toContain(agentId);
    expect(result.state.runs.filter((r) => r.agentId === agentId)).toEqual([]);
    expect(result.state.links).toEqual([]);
  });

  it("leaves another agent's runs and events completely alone", () => {
    const { state, agentId, otherAgentId } = populated();
    const result = deleteAgentAndRuns(state, agentId);
    if (!result.ok) throw new Error("expected success");

    expect(result.state.agents.map((a) => a.id)).toEqual([otherAgentId]);
    expect(result.state.runs).toHaveLength(1);
    expect(result.state.events).toHaveLength(1);
    expect(result.state.events[0].summary).toBe("Untouched");
  });
});
