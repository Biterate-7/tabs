import { describe, expect, it } from "vitest";
import { createAgent } from "./registry";
import {
  canTransition,
  createRun,
  deleteRun,
  findRun,
  findRunByExternalId,
  listRuns,
  transitionRunStatus,
  updateRun,
} from "./runs";
import { appendRunEvent } from "./events";
import { addRunLink } from "./links";
import {
  LIVE_AGENT_RUN_STATUSES,
  TERMINAL_AGENT_RUN_STATUSES,
  emptyAgentState,
} from "./types";
import type { AgentRunStatus, AgentState } from "./types";

const T0 = 1_700_000_000_000;

function seeded(): { state: AgentState; agentId: string } {
  const created = createAgent(emptyAgentState(), { provider: "p", name: "N" }, T0);
  if (!created.ok) throw new Error("fixture failed");
  return { state: created.state, agentId: created.agent.id };
}

function seededRun(status?: AgentRunStatus, workspaceId = "w1") {
  const { state, agentId } = seeded();
  const run = createRun(state, { agentId, workspaceId, status }, T0);
  if (!run.ok) throw new Error("fixture failed");
  return { state: run.state, run: run.run, agentId };
}

describe("createRun", () => {
  it("defaults to working, in the workspace it was given", () => {
    const { run } = seededRun();

    expect(run.status).toBe("working");
    expect(run.workspaceId).toBe("w1");
    expect(run.createdAt).toBe(T0);
    expect(run.updatedAt).toBe(T0);
    expect(run.endedAt).toBeUndefined();
  });

  it("refuses to create a run for an agent that does not exist", () => {
    expect(createRun(emptyAgentState(), { agentId: "ghost", workspaceId: "w1" }, T0)).toEqual({
      ok: false,
      reason: "agent-not-found",
    });
  });

  it("refuses a blank workspace id", () => {
    const { state, agentId } = seeded();

    expect(createRun(state, { agentId, workspaceId: "   " }, T0)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("stores optional metadata only when it carries something", () => {
    const { state, agentId } = seeded();
    const run = createRun(
      state,
      { agentId, workspaceId: "w1", externalId: " sess-1 ", title: "   " },
      T0
    );
    if (!run.ok) throw new Error("expected success");

    expect(run.run.externalId).toBe("sess-1");
    expect(run.run).not.toHaveProperty("title");
  });

  it("stamps endedAt when created directly into a terminal status", () => {
    const { run } = seededRun("completed");

    expect(run.endedAt).toBe(T0);
  });

  it("lists runs and finds them by id and external id", () => {
    const { state, run, agentId } = seededRun();
    const external = updateRun(state, run.id, { externalId: "sess-9" }, T0);
    if (!external.ok) throw new Error("expected success");

    expect(listRuns(external.state)).toHaveLength(1);
    expect(findRun(external.state, run.id)?.id).toBe(run.id);
    expect(findRunByExternalId(external.state, agentId, "sess-9")?.id).toBe(run.id);
  });

  it("scopes external-id lookup to the agent, so two providers cannot collide", () => {
    const { state, run, agentId } = seededRun();
    const tagged = updateRun(state, run.id, { externalId: "shared" }, T0);
    if (!tagged.ok) throw new Error("expected success");

    expect(findRunByExternalId(tagged.state, agentId, "shared")?.id).toBe(run.id);
    expect(findRunByExternalId(tagged.state, "other-agent", "shared")).toBeUndefined();
  });
});

describe("updateRun", () => {
  it("sets metadata and bumps updatedAt", () => {
    const { state, run } = seededRun();
    const result = updateRun(state, run.id, { title: "Add auth" }, T0 + 100);
    if (!result.ok) throw new Error("expected success");

    expect(result.run.title).toBe("Add auth");
    expect(result.run.updatedAt).toBe(T0 + 100);
  });

  it("treats an absent field as no news and keeps what is already known", () => {
    const { state, run } = seededRun();
    const titled = updateRun(state, run.id, { title: "Add auth" }, T0 + 100);
    if (!titled.ok) throw new Error("expected success");

    const later = updateRun(titled.state, run.id, { currentActivity: "Edited x.ts" }, T0 + 200);
    if (!later.ok) throw new Error("expected success");

    expect(later.run.title).toBe("Add auth");
    expect(later.run.currentActivity).toBe("Edited x.ts");
  });

  it("clears a field only when explicitly given an empty string", () => {
    const { state, run } = seededRun();
    const titled = updateRun(state, run.id, { title: "Add auth" }, T0 + 100);
    if (!titled.ok) throw new Error("expected success");

    const cleared = updateRun(titled.state, run.id, { title: "" }, T0 + 200);
    if (!cleared.ok) throw new Error("expected success");

    expect(cleared.run).not.toHaveProperty("title");
  });

  it("is a no-op when nothing actually changes", () => {
    const { state, run } = seededRun();
    const titled = updateRun(state, run.id, { title: "Same" }, T0 + 100);
    if (!titled.ok) throw new Error("expected success");

    const again = updateRun(titled.state, run.id, { title: "Same" }, T0 + 999);
    if (!again.ok) throw new Error("expected success");

    expect(again.state).toBe(titled.state);
    expect(again.run.updatedAt).toBe(T0 + 100);
  });

  it("rejects an unknown run", () => {
    const { state } = seededRun();

    expect(updateRun(state, "ghost", { title: "x" }, T0)).toEqual({
      ok: false,
      reason: "run-not-found",
    });
  });

  it("offers no way to change status or workspace", () => {
    const { state, run } = seededRun();
    // @ts-expect-error status is not part of UpdateRunPatch by design
    const attempt = updateRun(state, run.id, { status: "completed" }, T0 + 1);
    if (!attempt.ok) throw new Error("expected success");

    expect(attempt.run.status).toBe("working");
    expect(attempt.run.workspaceId).toBe("w1");
  });
});

describe("status transitions", () => {
  it("allows the two live states to swap", () => {
    expect(canTransition("working", "waiting")).toBe(true);
    expect(canTransition("waiting", "working")).toBe(true);
  });

  it("allows every live state to reach every terminal state", () => {
    for (const from of LIVE_AGENT_RUN_STATUSES) {
      for (const to of TERMINAL_AGENT_RUN_STATUSES) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("allows nothing out of a terminal state", () => {
    for (const from of TERMINAL_AGENT_RUN_STATUSES) {
      for (const to of [...LIVE_AGENT_RUN_STATUSES, ...TERMINAL_AGENT_RUN_STATUSES]) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("moves working to waiting and bumps updatedAt without ending the run", () => {
    const { state, run } = seededRun();
    const result = transitionRunStatus(state, run.id, "waiting", T0 + 50);
    if (!result.ok) throw new Error("expected success");

    expect(result.run.status).toBe("waiting");
    expect(result.run.updatedAt).toBe(T0 + 50);
    expect(result.run.endedAt).toBeUndefined();
  });

  it("stamps endedAt on reaching any terminal status", () => {
    for (const terminal of TERMINAL_AGENT_RUN_STATUSES) {
      const { state, run } = seededRun();
      const result = transitionRunStatus(state, run.id, terminal, T0 + 75);
      if (!result.ok) throw new Error("expected success");

      expect(result.run.status).toBe(terminal);
      expect(result.run.endedAt).toBe(T0 + 75);
    }
  });

  it("refuses to move a terminal run back to a live one", () => {
    const { state, run } = seededRun();
    const done = transitionRunStatus(state, run.id, "completed", T0 + 10);
    if (!done.ok) throw new Error("expected success");

    expect(transitionRunStatus(done.state, run.id, "working", T0 + 20)).toEqual({
      ok: false,
      reason: "terminal-run",
    });
    expect(transitionRunStatus(done.state, run.id, "failed", T0 + 20)).toEqual({
      ok: false,
      reason: "terminal-run",
    });
  });

  it("treats re-asserting a live status as a no-op that changes nothing", () => {
    const { state, run } = seededRun();
    const again = transitionRunStatus(state, run.id, "working", T0 + 5_000);
    if (!again.ok) throw new Error("expected success");

    expect(again.state).toBe(state);
    expect(again.run.updatedAt).toBe(T0);
  });

  it("refuses re-asserting a terminal status", () => {
    const { state, run } = seededRun("completed");

    expect(transitionRunStatus(state, run.id, "completed", T0 + 1)).toEqual({
      ok: false,
      reason: "terminal-run",
    });
  });

  it("rejects an unknown run", () => {
    const { state } = seededRun();

    expect(transitionRunStatus(state, "ghost", "completed", T0)).toEqual({
      ok: false,
      reason: "run-not-found",
    });
  });
});

describe("deleteRun", () => {
  it("removes the run with its links and events, keeping the agent", () => {
    const { state, run, agentId } = seededRun();

    const linked = addRunLink(
      state,
      { runId: run.id, tabId: "t1", role: "produced", tabWorkspaceId: "w1" },
      T0
    );
    if (!linked.ok) throw new Error("fixture failed");

    const evented = appendRunEvent(linked.state, {
      runId: run.id,
      kind: "activity",
      summary: "Edited a file",
      timestamp: T0,
    });
    if (!evented.ok) throw new Error("fixture failed");

    const result = deleteRun(evented.state, run.id);
    if (!result.ok) throw new Error("expected success");

    expect(result.state.runs).toEqual([]);
    expect(result.state.links).toEqual([]);
    expect(result.state.events).toEqual([]);
    expect(result.state.agents.map((a) => a.id)).toEqual([agentId]);
  });

  it("leaves a sibling run's links and events intact", () => {
    const { state, run, agentId } = seededRun();
    const sibling = createRun(state, { agentId, workspaceId: "w1" }, T0);
    if (!sibling.ok) throw new Error("fixture failed");

    const linked = addRunLink(
      sibling.state,
      { runId: sibling.run.id, tabId: "t2", role: "context", tabWorkspaceId: "w1" },
      T0
    );
    if (!linked.ok) throw new Error("fixture failed");

    const result = deleteRun(linked.state, run.id);
    if (!result.ok) throw new Error("expected success");

    expect(result.state.runs.map((r) => r.id)).toEqual([sibling.run.id]);
    expect(result.state.links).toHaveLength(1);
  });

  it("rejects an unknown run", () => {
    expect(deleteRun(emptyAgentState(), "ghost")).toEqual({ ok: false, reason: "run-not-found" });
  });
});
