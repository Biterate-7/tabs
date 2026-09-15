import { describe, expect, it } from "vitest";
import { ingestObservation } from "./adapter";
import { createAgent } from "./registry";
import { getRunWorkProgress, getWorkItemsForRun } from "./selectors";
import { emptyAgentState } from "./types";
import { findWorkItemByExternalId } from "./work-items";
import type { AgentAdapterObservation, ObservedWorkItem } from "./adapter";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;

/** An agent, ready to receive observations. */
function seeded() {
  const agent = createAgent(emptyAgentState(), { provider: "p", name: "N" }, T0);
  if (!agent.ok) throw new Error("fixture failed");
  return { state: agent.state, agentId: agent.agent.id };
}

function observe(
  state: AgentState,
  agentId: string,
  observation: Partial<AgentAdapterObservation>,
  now = T0
): AgentState {
  const result = ingestObservation(state, {
    agentId,
    observation: {
      provider: "p",
      externalId: "session-1",
      workspaceId: "wA",
      ...observation,
    },
    now,
  });
  if (!result.ok) throw new Error(`ingest failed: ${result.reason}`);
  return result.state;
}

/** The run the fixture observations all belong to. */
function runIdOf(state: AgentState): string {
  const run = state.runs[0];
  if (!run) throw new Error("no run");
  return run.id;
}

describe("ingesting work items", () => {
  it("creates work items alongside the run they describe", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Implement authentication" }],
    });

    const runId = runIdOf(next);
    const items = getWorkItemsForRun(next, runId);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Implement authentication");
    expect(items[0].workspaceId).toBe("wA");
  });

  it("is idempotent: re-observing the same task updates one item", () => {
    const { state, agentId } = seeded();
    const item: ObservedWorkItem = { externalId: "1", title: "Do the thing" };

    let next = observe(state, agentId, { workItems: [item] });
    next = observe(next, agentId, { workItems: [item] }, T1);
    next = observe(next, agentId, { workItems: [item] }, T1);

    expect(getWorkItemsForRun(next, runIdOf(next))).toHaveLength(1);
  });

  it("folds a duplicate id within a single observation only once", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      workItems: [
        { externalId: "1", title: "First wins" },
        { externalId: "1", title: "Second ignored" },
      ],
    });

    const items = getWorkItemsForRun(next, runIdOf(next));
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("First wins");
  });

  it("creates nothing for an observation with no workspace mapping", () => {
    const { state, agentId } = seeded();
    const result = ingestObservation(state, {
      agentId,
      observation: {
        provider: "p",
        externalId: "session-1",
        workItems: [{ externalId: "1", title: "Orphan" }],
      },
      now: T0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("unattached");
    expect(result.state.workItems).toEqual([]);
  });
});

describe("what ingestion refuses to invent", () => {
  it("drops a status-only entry for a task it has never seen", () => {
    const { state, agentId } = seeded();
    // The creation fell outside the window this poll read. There is no title,
    // so there is nothing honest to show — the update is dropped entirely.
    const next = observe(state, agentId, {
      workItems: [{ externalId: "7", status: "completed" }],
    });

    expect(getWorkItemsForRun(next, runIdOf(next))).toEqual([]);
  });

  it("applies a status-only entry to a task an earlier poll named", () => {
    const { state, agentId } = seeded();
    let next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Write the docs", status: "pending" }],
    });
    next = observe(next, agentId, { workItems: [{ externalId: "1", status: "active" }] }, T1);

    const item = findWorkItemByExternalId(next, runIdOf(next), "1");
    expect(item?.title).toBe("Write the docs");
    expect(item?.status).toBe("active");
    expect(item?.startedAt).toBe(T1);
  });

  it("never closes an item merely because it stopped being reported", () => {
    const { state, agentId } = seeded();
    let next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Long task", status: "active" }],
    });

    // Several polls carrying no work items at all — the session went quiet,
    // the transcript ended, nothing was said about the task.
    next = observe(next, agentId, { activity: "Ran the tests" }, T1);
    next = observe(next, agentId, {}, T1);
    next = observe(next, agentId, { workItems: [] }, T1);

    expect(findWorkItemByExternalId(next, runIdOf(next), "1")?.status).toBe("active");
  });

  it("keeps existing state when a stale observation reports an illegal move", () => {
    const { state, agentId } = seeded();
    let next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Task", status: "active" }],
    });
    next = observe(next, agentId, { workItems: [{ externalId: "1", status: "completed" }] }, T1);

    // Now a stale poll re-reports it as active. A finished item does not reopen.
    next = observe(next, agentId, { workItems: [{ externalId: "1", status: "active" }] }, T1);

    const item = findWorkItemByExternalId(next, runIdOf(next), "1");
    expect(item?.status).toBe("completed");
    expect(item?.completedAt).toBe(T1);
  });

  it("keeps the rest of an observation when one work item is refused", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      activity: "Edited artifacts.ts",
      workItems: [
        { externalId: "9", status: "completed" },
        { externalId: "1", title: "Real task" },
      ],
    });

    const runId = runIdOf(next);
    expect(getWorkItemsForRun(next, runId).map((i) => i.title)).toEqual(["Real task"]);
    expect(next.runs[0].currentActivity).toBe("Edited artifacts.ts");
  });

  it("reports no progress when the provider counted nothing", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Task" }],
    });

    // The item's own explicit progress is absent, because none was observed.
    expect(findWorkItemByExternalId(next, runIdOf(next), "1")?.progress).toBeUndefined();
    // Derived run progress exists, because it is a count of real items.
    expect(getRunWorkProgress(next, runIdOf(next))).toEqual({ completed: 0, total: 1 });
  });

  it("does not erase explicit progress an earlier poll established", () => {
    const { state, agentId } = seeded();
    let next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Task", progress: { completed: 2, total: 5 } }],
    });
    next = observe(next, agentId, { workItems: [{ externalId: "1", title: "Task" }] }, T1);

    expect(findWorkItemByExternalId(next, runIdOf(next), "1")?.progress).toEqual({
      completed: 2,
      total: 5,
    });
  });
});

describe("what a work item observation cannot carry", () => {
  it("has no field for a prompt, a command, or a tool payload", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      workItems: [
        {
          externalId: "1",
          title: "Task",
          // Fields a provider might try to smuggle through. None is read.
          prompt: "rm -rf /",
          command: "git push --force",
          thinking: "the model's reasoning",
          toolUseResult: "output",
          old_string: "secret",
        } as never,
      ],
    });

    const item = findWorkItemByExternalId(next, runIdOf(next), "1");
    expect(item).toBeDefined();
    // The stored record holds exactly the domain's own keys and nothing else.
    expect(Object.keys(item!).sort()).toEqual(
      [
        "createdAt",
        "externalId",
        "id",
        "runId",
        "status",
        "title",
        "updatedAt",
        "workspaceId",
      ].sort()
    );
  });

  it("bounds a title and a summary a provider sends oversized", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "T".repeat(5_000), summary: "S".repeat(5_000) }],
    });

    const item = findWorkItemByExternalId(next, runIdOf(next), "1");
    expect(item!.title.length).toBeLessThanOrEqual(120);
    expect(item!.summary!.length).toBeLessThanOrEqual(400);
  });

  it("collapses newlines so one item cannot become a wall of text", () => {
    const { state, agentId } = seeded();
    const next = observe(state, agentId, {
      workItems: [{ externalId: "1", title: "Line one\n\nLine two\tand three" }],
    });

    expect(findWorkItemByExternalId(next, runIdOf(next), "1")?.title).toBe(
      "Line one Line two and three"
    );
  });
});

describe("work items and the workspace boundary", () => {
  it("files items under the run's workspace, not one the observation names", () => {
    const { state, agentId } = seeded();
    let next = observe(state, agentId, { workspaceId: "wA", workItems: [] });

    // A later observation for the same session claiming a different workspace.
    // Run identity is (agent, externalId), so this updates the SAME run — and
    // the item must follow the run, never the claim.
    next = observe(
      next,
      agentId,
      { workspaceId: "wB", workItems: [{ externalId: "1", title: "Task" }] },
      T1
    );

    expect(next.runs).toHaveLength(1);
    expect(next.workItems).toHaveLength(1);
    expect(next.workItems[0].workspaceId).toBe("wA");
    expect(next.workItems[0].workspaceId).toBe(next.runs[0].workspaceId);
  });

  it("keeps two sessions' work items apart even with colliding provider ids", () => {
    const { state, agentId } = seeded();
    let next = observe(state, agentId, {
      externalId: "session-1",
      workspaceId: "w1",
      workItems: [{ externalId: "1", title: "Session one task" }],
    });
    next = observe(next, agentId, {
      externalId: "session-2",
      workspaceId: "w2",
      workItems: [{ externalId: "1", title: "Session two task" }],
    });

    expect(next.workItems).toHaveLength(2);
    const byWorkspace = new Map(next.workItems.map((i) => [i.workspaceId, i.title]));
    expect(byWorkspace.get("w1")).toBe("Session one task");
    expect(byWorkspace.get("w2")).toBe("Session two task");
  });
});
