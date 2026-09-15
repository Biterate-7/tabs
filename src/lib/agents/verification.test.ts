import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStorageNamespace } from "@/lib/storage/namespace";
import { ingestObservation } from "./adapter";
import { appendRunEvent } from "./events";
import { addRunLink } from "./links";
import { loadAgentState, saveAgentState } from "./persistence";
import { createAgent, deleteAgent, findAgentByProvider } from "./registry";
import { createRun, deleteRun, transitionRunStatus } from "./runs";
import {
  getActiveRuns,
  getRunActivity,
  getRunEvents,
  getRunLinks,
  getRunLinksByRole,
  getWorkspaceRunCounts,
  getWorkspaceRuns,
} from "./selectors";
import { emptyAgentState } from "./types";
import type { AgentState } from "./types";

/**
 * The end-to-end shape of the feature, exercised through the real modules and
 * real localStorage rather than by asserting on internals.
 *
 * This is the test that would notice if the pieces stopped fitting together:
 * every other suite checks one module in isolation, and a domain can pass all
 * of those while still being unusable as a whole.
 */

const T0 = 1_700_000_000_000;
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe("a full run, from creation to deletion", () => {
  it("survives every step and a reload in between", () => {
    // A. an account-scoped agent identity
    setStorageNamespace(ADA);
    const agent = expectOk(
      createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
    );

    // B. a workspace-scoped run
    const run = expectOk(
      createRun(
        agent.state,
        {
          agentId: agent.agent.id,
          workspaceId: "wA",
          externalId: "sess-1",
          title: "Implement authentication",
        },
        T0
      )
    );
    expect(run.run.status).toBe("working");

    // C. context and produced links to existing tabs
    let state: AgentState = run.state;
    state = expectOk(
      addRunLink(state, { runId: run.run.id, tabId: "t-spec", role: "context", tabWorkspaceId: "wA" }, T0 + 1)
    ).state;
    state = expectOk(
      addRunLink(state, { runId: run.run.id, tabId: "t-pr", role: "produced", tabWorkspaceId: "wA" }, T0 + 2)
    ).state;

    expect(getRunLinks(state, run.run.id)).toHaveLength(2);
    expect(getRunLinksByRole(state, run.run.id, "produced").map((l) => l.tabId)).toEqual(["t-pr"]);

    // …and a tab from another workspace is refused
    expect(
      addRunLink(state, { runId: run.run.id, tabId: "t-other", role: "context", tabWorkspaceId: "wB" }, T0 + 3)
    ).toEqual({ ok: false, reason: "cross-workspace" });

    // D. activity
    for (const [i, summary] of ["Read auth.ts", "Edited auth.ts", "Edited session.ts"].entries()) {
      state = expectOk(
        appendRunEvent(state, {
          runId: run.run.id,
          kind: "activity",
          summary,
          sourceId: `toolu_${i}`,
          timestamp: T0 + 10 + i,
        })
      ).state;
    }
    expect(getRunEvents(state, run.run.id)).toHaveLength(3);

    // E. working -> waiting -> working -> completed
    state = expectOk(transitionRunStatus(state, run.run.id, "waiting", T0 + 20)).state;
    state = expectOk(transitionRunStatus(state, run.run.id, "working", T0 + 30)).state;
    expect(getActiveRuns(state, "wA")).toHaveLength(1);

    state = expectOk(transitionRunStatus(state, run.run.id, "completed", T0 + 40)).state;
    expect(state.runs[0].endedAt).toBe(T0 + 40);
    expect(getActiveRuns(state, "wA")).toEqual([]);
    expect(getWorkspaceRunCounts(state, "wA")).toEqual({ total: 1, active: 0, finished: 1 });

    // F/G. reload — everything comes back
    expect(saveAgentState(state)).toBe(true);
    const reloaded = loadAgentState();

    expect(reloaded.status).toBe("loaded");
    expect(reloaded.state).toEqual(state);
    expect(getWorkspaceRuns(reloaded.state, "wA")).toHaveLength(1);
    expect(getRunLinks(reloaded.state, run.run.id)).toHaveLength(2);
    expect(getRunEvents(reloaded.state, run.run.id)).toHaveLength(3);
    expect(getRunActivity(reloaded.state, run.run.id)).toBe("Edited session.ts");

    // H/I. deleting the run cascades to its links and events
    const deleted = expectOk(deleteRun(reloaded.state, run.run.id));

    expect(deleted.state.runs).toEqual([]);
    expect(deleted.state.links).toEqual([]);
    expect(deleted.state.events).toEqual([]);

    // J. the agent identity outlives the run, and is now deletable
    expect(deleted.state.agents).toHaveLength(1);
    expect(expectOk(deleteAgent(deleted.state, agent.agent.id)).state.agents).toEqual([]);
  });

  it("keeps another account from seeing any of it", () => {
    // K. Ada's domain, saved under her namespace
    setStorageNamespace(ADA);
    const agent = expectOk(
      createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
    );
    const run = expectOk(
      createRun(agent.state, { agentId: agent.agent.id, workspaceId: "ada-w" }, T0)
    );
    saveAgentState(run.state);

    // Grace sees nothing at all
    setStorageNamespace(GRACE);
    const graceView = loadAgentState();
    expect(graceView.status).toBe("empty");
    expect(graceView.state.agents).toEqual([]);
    expect(graceView.state.runs).toEqual([]);

    // Grace's own agent does not disturb Ada's
    const graceAgent = expectOk(
      createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
    );
    const graceRun = expectOk(
      createRun(graceAgent.state, { agentId: graceAgent.agent.id, workspaceId: "grace-w" }, T0)
    );
    saveAgentState(graceRun.state);

    setStorageNamespace(ADA);
    const adaView = loadAgentState();
    expect(adaView.state.runs).toHaveLength(1);
    expect(adaView.state.runs[0].workspaceId).toBe("ada-w");
    expect(adaView.state.runs[0].id).toBe(run.run.id);
  });
});

describe("an observed session, end to end", () => {
  it("goes from an adapter observation to a persisted run and back", () => {
    setStorageNamespace(ADA);

    const agent = expectOk(
      createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0)
    );
    const agentId = expectOk(
      { ok: true as const, value: findAgentByProvider(agent.state, "claude-code") }
    ).value!.id;

    // First sighting: no workspace mapping yet, so nothing is created.
    const discovered = expectOk(
      ingestObservation(agent.state, {
        agentId,
        observation: { provider: "claude-code", externalId: "sess-77", status: "working" },
        now: T0,
      })
    );
    expect(discovered.outcome).toBe("unattached");
    expect(discovered.state.runs).toEqual([]);

    // The user maps the project to a workspace; the same session now attaches.
    const attached = expectOk(
      ingestObservation(discovered.state, {
        agentId,
        observation: {
          provider: "claude-code",
          externalId: "sess-77",
          workspaceId: "wA",
          status: "working",
          title: "Fix the sync poller",
          activity: "Edited engine.ts",
          sourceId: "toolu_a",
        },
        now: T0 + 10,
      })
    );
    expect(attached.outcome).toBe("created");

    // Polling again with nothing new adds nothing.
    const repolled = expectOk(
      ingestObservation(attached.state, {
        agentId,
        observation: {
          provider: "claude-code",
          externalId: "sess-77",
          workspaceId: "wA",
          status: "working",
          activity: "Edited engine.ts",
          sourceId: "toolu_a",
        },
        now: T0 + 20,
      })
    );
    expect(repolled.state.runs).toHaveLength(1);
    expect(getRunEvents(repolled.state, repolled.run!.id).filter((e) => e.kind === "activity")).toHaveLength(1);

    // The session ends, and the run ends with it.
    const finished = expectOk(
      ingestObservation(repolled.state, {
        agentId,
        observation: {
          provider: "claude-code",
          externalId: "sess-77",
          workspaceId: "wA",
          status: "completed",
        },
        now: T0 + 30,
      })
    );
    expect(finished.run!.status).toBe("completed");
    expect(finished.run!.title).toBe("Fix the sync poller");

    // And it survives a reload with its identity intact, so a restarted app
    // reconnects to the same run instead of minting a second one.
    saveAgentState(finished.state);
    const reloaded = loadAgentState();

    expect(reloaded.state.runs).toHaveLength(1);
    expect(reloaded.state.runs[0].externalId).toBe("sess-77");
    expect(getRunActivity(reloaded.state, reloaded.state.runs[0].id)).toBe("Edited engine.ts");
  });
});
