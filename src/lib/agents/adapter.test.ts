import { describe, expect, it, vi } from "vitest";
import { ingestObservation } from "./adapter";
import { createMockAgentAdapter } from "./mock-adapter";
import { createAgent } from "./registry";
import { findRunByExternalId } from "./runs";
import { getRunActivity, getRunEvents } from "./selectors";
import { emptyAgentState } from "./types";
import type { AgentAdapterObservation } from "./adapter";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;

function seeded(): { state: AgentState; agentId: string } {
  const agent = createAgent(emptyAgentState(), { provider: "mock", name: "Mock" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  return { state: agent.state, agentId: agent.agent.id };
}

function ingest(
  state: AgentState,
  agentId: string,
  observation: AgentAdapterObservation,
  now = T0
): { state: AgentState; outcome: string } {
  const result = ingestObservation(state, { agentId, observation, now });
  if (!result.ok) throw new Error(`ingest failed: ${result.reason}`);
  return { state: result.state, outcome: result.outcome };
}

const base: AgentAdapterObservation = { provider: "mock", externalId: "sess-1" };

describe("the adapter interface", () => {
  it("exposes observation only — no control surface", () => {
    const adapter = createMockAgentAdapter();
    const forbidden = ["start", "stop", "kill", "exec", "run", "prompt", "sendMessage", "write"];

    for (const method of forbidden) {
      expect(adapter).not.toHaveProperty(method);
    }
    // `emit` and `subscriberCount` exist only on the test double; the real
    // interface is `provider` plus `subscribe`.
    expect(Object.keys(adapter).sort()).toEqual([
      "emit",
      "provider",
      "subscribe",
      "subscriberCount",
    ]);
  });

  it("delivers observations to subscribers and stops on unsubscribe", () => {
    const adapter = createMockAgentAdapter();
    const seen = vi.fn();

    const unsubscribe = adapter.subscribe(seen);
    adapter.emit([base]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([base]);

    unsubscribe();
    adapter.emit([base]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(adapter.subscriberCount).toBe(0);
  });

  it("tolerates unsubscribing twice, as a React effect cleanup may", () => {
    const adapter = createMockAgentAdapter();
    const unsubscribe = adapter.subscribe(vi.fn());

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(adapter.subscriberCount).toBe(0);
  });
});

describe("attaching observations to workspaces", () => {
  it("creates no run when the observation has no workspace mapping", () => {
    const { state, agentId } = seeded();
    const result = ingest(state, agentId, { ...base, status: "working" });

    expect(result.outcome).toBe("unattached");
    expect(result.state.runs).toEqual([]);
    expect(result.state).toBe(state);
  });

  it("creates a run once a workspace mapping is supplied", () => {
    const { state, agentId } = seeded();
    const result = ingest(state, agentId, { ...base, workspaceId: "w1", title: "Add auth" });

    expect(result.outcome).toBe("created");
    expect(result.state.runs).toHaveLength(1);
    expect(result.state.runs[0].workspaceId).toBe("w1");
    expect(result.state.runs[0].externalId).toBe("sess-1");
    expect(result.state.runs[0].title).toBe("Add auth");
  });

  it("attaches a session that was previously unattached, on a later observation", () => {
    const { state, agentId } = seeded();

    const first = ingest(state, agentId, { ...base, activity: "Edited a.ts" });
    expect(first.outcome).toBe("unattached");

    const second = ingest(first.state, agentId, { ...base, workspaceId: "w1" });
    expect(second.outcome).toBe("created");
    expect(findRunByExternalId(second.state, agentId, "sess-1")).toBeDefined();
  });

  it("records a started event when it creates the run", () => {
    const { state, agentId } = seeded();
    const result = ingest(state, agentId, { ...base, workspaceId: "w1", title: "Add auth" });
    const events = getRunEvents(result.state, result.state.runs[0].id);

    expect(events[0].kind).toBe("started");
    expect(events[0].summary).toBe("Add auth");
  });
});

describe("session identity", () => {
  it("updates one run across repeated observations of the same session", () => {
    const { state, agentId } = seeded();
    let next = ingest(state, agentId, { ...base, workspaceId: "w1" }).state;
    next = ingest(next, agentId, { ...base, workspaceId: "w1", status: "waiting" }, T0 + 10).state;
    next = ingest(next, agentId, { ...base, workspaceId: "w1", status: "working" }, T0 + 20).state;

    expect(next.runs).toHaveLength(1);
    expect(next.runs[0].status).toBe("working");
  });

  it("gives a different session its own run", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, { ...base, workspaceId: "w1" });
    const second = ingest(first.state, agentId, {
      ...base,
      externalId: "sess-2",
      workspaceId: "w1",
    });

    expect(second.state.runs).toHaveLength(2);
  });

  it("rejects a blank external id", () => {
    const { state, agentId } = seeded();
    const result = ingestObservation(state, {
      agentId,
      observation: { ...base, externalId: "  " },
      now: T0,
    });

    expect(result).toEqual({ ok: false, reason: "invalid-input" });
  });
});

describe("incremental observation", () => {
  it("does not erase known metadata when a later observation omits it", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, {
      ...base,
      workspaceId: "w1",
      title: "Implement authentication",
      activity: "Edited auth.ts",
    });

    const second = ingest(
      first.state,
      agentId,
      { ...base, workspaceId: "w1", status: "waiting" },
      T0 + 10
    );

    const run = second.state.runs[0];
    expect(run.title).toBe("Implement authentication");
    expect(run.currentActivity).toBe("Edited auth.ts");
    expect(run.status).toBe("waiting");
  });

  it("keeps the last meaningful activity rather than downgrading it", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, {
      ...base,
      workspaceId: "w1",
      activity: "Edited graph-canvas.tsx",
    });
    const second = ingest(first.state, agentId, { ...base, workspaceId: "w1" }, T0 + 10);

    expect(getRunActivity(second.state, second.state.runs[0].id)).toBe("Edited graph-canvas.tsx");
  });

  it("does not duplicate an event when the same source record is observed twice", () => {
    const { state, agentId } = seeded();
    const observation = {
      ...base,
      workspaceId: "w1",
      activity: "Edited a.ts",
      sourceId: "toolu_1",
    };

    const first = ingest(state, agentId, observation);
    const second = ingest(first.state, agentId, observation, T0 + 10);
    const third = ingest(second.state, agentId, observation, T0 + 20);

    const activity = getRunEvents(third.state, third.state.runs[0].id).filter(
      (e) => e.kind === "activity"
    );
    expect(activity).toHaveLength(1);
  });

  it("appends a new event when a genuinely new source record arrives", () => {
    const { state, agentId } = seeded();
    let next = ingest(state, agentId, {
      ...base,
      workspaceId: "w1",
      activity: "Edited a.ts",
      sourceId: "toolu_1",
    }).state;
    next = ingest(
      next,
      agentId,
      { ...base, workspaceId: "w1", activity: "Edited b.ts", sourceId: "toolu_2" },
      T0 + 10
    ).state;

    const activity = getRunEvents(next, next.runs[0].id).filter((e) => e.kind === "activity");
    expect(activity.map((e) => e.summary)).toEqual(["Edited a.ts", "Edited b.ts"]);
  });

  it("uses the observation's own timestamp rather than the ingest clock", () => {
    const { state, agentId } = seeded();
    const result = ingest(
      state,
      agentId,
      { ...base, workspaceId: "w1", activity: "Edited a.ts", observedAt: T0 - 60_000 },
      T0
    );

    const activity = getRunEvents(result.state, result.state.runs[0].id).find(
      (e) => e.kind === "activity"
    );
    expect(activity?.timestamp).toBe(T0 - 60_000);
  });

  it("falls back to the ingest clock when the observation has no usable timestamp", () => {
    const { state, agentId } = seeded();
    const result = ingest(
      state,
      agentId,
      { ...base, workspaceId: "w1", activity: "Edited a.ts", observedAt: Number.NaN },
      T0 + 42
    );

    const activity = getRunEvents(result.state, result.state.runs[0].id).find(
      (e) => e.kind === "activity"
    );
    expect(activity?.timestamp).toBe(T0 + 42);
  });
});

describe("status handling", () => {
  it("records a status event on a live transition", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, { ...base, workspaceId: "w1", status: "working" });
    const second = ingest(
      first.state,
      agentId,
      { ...base, workspaceId: "w1", status: "waiting" },
      T0 + 10
    );

    const status = getRunEvents(second.state, second.state.runs[0].id).find(
      (e) => e.kind === "status"
    );
    expect(status?.summary).toBe("Now waiting");
  });

  it("records an ended event and stamps endedAt on a terminal observation", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, { ...base, workspaceId: "w1", status: "working" });
    const second = ingest(
      first.state,
      agentId,
      { ...base, workspaceId: "w1", status: "completed" },
      T0 + 10
    );

    const run = second.state.runs[0];
    expect(run.status).toBe("completed");
    expect(run.endedAt).toBe(T0 + 10);
    expect(getRunEvents(second.state, run.id).some((e) => e.kind === "ended")).toBe(true);
  });

  it("keeps a finished run finished when a stale observation reports it working", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, { ...base, workspaceId: "w1", status: "completed" });
    const stale = ingest(
      first.state,
      agentId,
      { ...base, workspaceId: "w1", status: "working", activity: "Edited a.ts" },
      T0 + 10
    );

    expect(stale.outcome).toBe("updated");
    expect(stale.state.runs[0].status).toBe("completed");
    // The refused transition does not discard the rest of the observation.
    expect(stale.state.runs[0].currentActivity).toBe("Edited a.ts");
  });

  it("leaves a run alone when the status is simply re-asserted", () => {
    const { state, agentId } = seeded();
    const first = ingest(state, agentId, { ...base, workspaceId: "w1", status: "working" });
    const again = ingest(
      first.state,
      agentId,
      { ...base, workspaceId: "w1", status: "working" },
      T0 + 5_000
    );

    expect(again.state.runs[0].updatedAt).toBe(first.state.runs[0].updatedAt);
    expect(getRunEvents(again.state, again.state.runs[0].id).filter((e) => e.kind === "status")).toEqual([]);
  });
});

describe("observation safety", () => {
  it("normalizes a multi-line activity summary into one bounded line", () => {
    const { state, agentId } = seeded();
    const result = ingest(state, agentId, {
      ...base,
      workspaceId: "w1",
      activity: "  Edited\n   graph-canvas.tsx  ",
    });

    expect(result.state.runs[0].currentActivity).toBe("Edited graph-canvas.tsx");
  });

  it("has no field for a raw provider payload", () => {
    const observation: AgentAdapterObservation = { ...base, workspaceId: "w1" };
    const permitted = [
      "provider",
      "externalId",
      "workspaceId",
      "status",
      "title",
      "activity",
      "projectKey",
      "gitBranch",
      "sourceId",
      "url",
      "observedAt",
    ];

    // A compile-time guarantee re-stated at runtime: anything a provider adds
    // beyond this list is not part of the contract.
    for (const key of Object.keys(observation)) {
      expect(permitted).toContain(key);
    }
  });
});
