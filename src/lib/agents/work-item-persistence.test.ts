import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scopedKey, setStorageNamespace } from "@/lib/storage/namespace";
import { AGENT_STORAGE_KEY, loadAgentState, saveAgentState } from "./persistence";
import { createAgent } from "./registry";
import { createRun } from "./runs";
import { AGENT_STATE_VERSION, MAX_WORK_ITEMS_PER_RUN, emptyAgentState } from "./types";
import { createWorkItem, transitionWorkItem } from "./work-items";
import type { AgentState } from "./types";

const T0 = 1_700_000_000_000;
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";

/** One agent, one run in `w1`, and one work item on it. */
function populated(workspaceId = "w1") {
  const agent = createAgent(emptyAgentState(), { provider: "claude-code", name: "Claude Code" }, T0);
  if (!agent.ok) throw new Error("fixture failed");

  const run = createRun(agent.state, { agentId: agent.agent.id, workspaceId }, T0);
  if (!run.ok) throw new Error("fixture failed");

  const item = createWorkItem(
    run.state,
    {
      runId: run.run.id,
      title: "Implement authentication",
      summary: "Sign-in route and tests",
      externalId: "1",
    },
    T0
  );
  if (!item.ok) throw new Error("fixture failed");

  return { state: item.state, runId: run.run.id, itemId: item.workItem.id };
}

function writeRaw(value: unknown): void {
  window.localStorage.setItem(scopedKey(AGENT_STORAGE_KEY), JSON.stringify(value));
}

/** A stored record with `workItems` replaced by whatever a test wants to try. */
function storedWith(workItems: unknown, state: AgentState): void {
  writeRaw({ ...state, workItems });
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
  it("saves and reloads work items intact", () => {
    const { state } = populated();
    expect(saveAgentState(state)).toBe(true);

    const load = loadAgentState();
    expect(load.status).toBe("loaded");
    expect(load.state).toEqual(state);
  });

  it("preserves lifecycle timestamps across a reload", () => {
    const { state, itemId } = populated();
    const active = transitionWorkItem(state, itemId, "active", T0 + 100);
    if (!active.ok) throw new Error("fixture failed");
    const done = transitionWorkItem(active.state, itemId, "completed", T0 + 200);
    if (!done.ok) throw new Error("fixture failed");

    saveAgentState(done.state);
    const item = loadAgentState().state.workItems[0];

    expect(item.startedAt).toBe(T0 + 100);
    expect(item.completedAt).toBe(T0 + 200);
    expect(item.status).toBe("completed");
  });

  it("preserves explicit progress", () => {
    const { state, runId } = populated();
    const withProgress = createWorkItem(
      state,
      { runId, title: "Counted work", progress: { completed: 2, total: 5 } },
      T0
    );
    if (!withProgress.ok) throw new Error("fixture failed");

    saveAgentState(withProgress.state);
    const reloaded = loadAgentState().state.workItems.find((i) => i.title === "Counted work");
    expect(reloaded?.progress).toEqual({ completed: 2, total: 5 });
  });
});

describe("compatibility with state written before work items existed", () => {
  it("loads a record with no workItems key at all, without error", () => {
    const { state } = populated();
    // Exactly what an older build wrote: the key simply is not there.
    const withoutWorkItems: Record<string, unknown> = { ...state };
    delete withoutWorkItems.workItems;
    writeRaw(withoutWorkItems);

    const load = loadAgentState();
    expect(load.status).toBe("loaded");
    // Everything else survives; work items default to empty rather than
    // failing the load and costing the user their agent history.
    expect(load.state.workItems).toEqual([]);
    expect(load.state.agents).toHaveLength(1);
    expect(load.state.runs).toHaveLength(1);
  });

  it("does not change the schema version to read them", () => {
    const { state } = populated();
    saveAgentState(state);
    const raw = JSON.parse(window.localStorage.getItem(scopedKey(AGENT_STORAGE_KEY))!);
    expect(raw.version).toBe(AGENT_STATE_VERSION);
  });

  it("still fails closed on a version from a newer build", () => {
    const { state } = populated();
    writeRaw({ ...state, version: AGENT_STATE_VERSION + 1 });

    const load = loadAgentState();
    expect(load.status).toBe("unsupported");
    expect(load.state.workItems).toEqual([]);
  });
});

describe("malformed work items are dropped, never trusted", () => {
  it("drops an item whose run no longer exists", () => {
    const { state } = populated();
    storedWith([{ ...state.workItems[0], runId: "ghost-run" }], state);

    expect(loadAgentState().state.workItems).toEqual([]);
  });

  it("drops an item whose workspace disagrees with its run's", () => {
    const { state } = populated();
    // The one thing that could only have got there by editing the file — and
    // honouring it would leak one workspace's work into another's selectors.
    storedWith([{ ...state.workItems[0], workspaceId: "w2" }], state);

    expect(loadAgentState().state.workItems).toEqual([]);
  });

  it("drops items with an unusable status, title or timestamp", () => {
    const { state } = populated();
    const good = state.workItems[0];

    storedWith(
      [
        { ...good, id: "a", status: "in_progress" },
        { ...good, id: "b", status: undefined },
        { ...good, id: "c", title: "" },
        { ...good, id: "d", title: "   " },
        { ...good, id: "e", title: 42 },
        { ...good, id: "f", createdAt: "yesterday" },
        // Note: a negative epoch is NOT rejected, here or anywhere else in
        // this file. `isValidTimestamp` accepts any finite number, and work
        // items follow the same rule runs, links, events and artifacts do
        // rather than inventing a stricter one for themselves.
        { ...good, id: "g", createdAt: Number.NaN },
        { ...good, id: "h", runId: 7 },
        { ...good, id: "i", workspaceId: "" },
        "not an object",
        null,
      ],
      state
    );

    expect(loadAgentState().state.workItems).toEqual([]);
  });

  it("drops duplicate ids, keeping the first", () => {
    const { state } = populated();
    const good = state.workItems[0];
    storedWith([good, { ...good, title: "Impostor" }], state);

    const loaded = loadAgentState().state.workItems;
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Implement authentication");
  });

  it("drops progress that is not a real ratio, keeping the item", () => {
    const { state } = populated();
    const good = state.workItems[0];
    storedWith([{ ...good, progress: { completed: 9, total: 2 } }], state);

    const loaded = loadAgentState().state.workItems;
    expect(loaded).toHaveLength(1);
    // The item is real; only the impossible claim about it is discarded.
    expect(loaded[0].progress).toBeUndefined();
  });

  it("reconciles timestamps with status rather than trusting both", () => {
    const { state } = populated();
    const good = state.workItems[0];

    storedWith(
      [
        // Terminal with no completion stamp: one is supplied from updatedAt.
        { ...good, id: "x", status: "completed", completedAt: undefined },
        // Live with a completion stamp: it is not carried over.
        { ...good, id: "y", status: "active", completedAt: T0 + 5 },
      ],
      state
    );

    const byId = new Map(loadAgentState().state.workItems.map((i) => [i.id, i]));
    expect(byId.get("x")?.completedAt).toBe(good.updatedAt);
    expect(byId.get("y")?.completedAt).toBeUndefined();
  });

  it("re-applies the per-run bound to state it did not write", () => {
    const { state, runId } = populated();
    const good = state.workItems[0];

    const oversized = Array.from({ length: MAX_WORK_ITEMS_PER_RUN + 25 }, (_, i) => ({
      ...good,
      id: `item-${i}`,
      runId,
    }));
    storedWith(oversized, state);

    expect(loadAgentState().state.workItems).toHaveLength(MAX_WORK_ITEMS_PER_RUN);
  });

  it("normalises an oversized title read from storage", () => {
    const { state } = populated();
    storedWith([{ ...state.workItems[0], title: "T".repeat(5_000) }], state);

    const loaded = loadAgentState().state.workItems[0];
    expect(loaded.title.length).toBeLessThanOrEqual(120);
  });

  it("survives a workItems key that is not an array", () => {
    const { state } = populated();
    for (const value of ["nope", 42, {}, null]) {
      storedWith(value, state);
      const load = loadAgentState();
      expect(load.status).toBe("loaded");
      expect(load.state.workItems).toEqual([]);
    }
  });
});

describe("account isolation", () => {
  it("keeps one account's work items invisible to another", () => {
    setStorageNamespace(ADA);
    const ada = populated("w1");
    saveAgentState(ada.state);

    setStorageNamespace(GRACE);
    // Grace has never stored anything: she gets an empty domain, not Ada's.
    expect(loadAgentState().state.workItems).toEqual([]);

    const grace = populated("w1");
    saveAgentState(grace.state);
    expect(loadAgentState().state.workItems[0].id).toBe(grace.itemId);

    setStorageNamespace(ADA);
    expect(loadAgentState().state.workItems[0].id).toBe(ada.itemId);
  });

  it("writes each account's work items under its own key", () => {
    setStorageNamespace(ADA);
    saveAgentState(populated().state);
    const adaKey = scopedKey(AGENT_STORAGE_KEY);

    setStorageNamespace(GRACE);
    const graceKey = scopedKey(AGENT_STORAGE_KEY);

    expect(adaKey).not.toBe(graceKey);
    expect(window.localStorage.getItem(graceKey)).toBeNull();
  });
});
