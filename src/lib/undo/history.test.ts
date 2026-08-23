import { describe, expect, it } from "vitest";
import { MAX_UNDO_HISTORY, attemptUndo, findUndoEntry, markUndone, pushUndoEntry, storesMatch } from "./history";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { UndoEntry } from "./types";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("pushUndoEntry", () => {
  it("adds a new active entry with the given before/after states and description", () => {
    const before = makeStore([makeWorkspace({ id: "a" })], "a");
    const after = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");

    const { history, entry } = pushUndoEntry([], { beforeState: before, afterState: after, description: "Created workspace" });

    expect(history).toHaveLength(1);
    expect(history[0]).toBe(entry);
    expect(entry).toMatchObject({ description: "Created workspace", beforeState: before, afterState: after, status: "active" });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.timestamp).toEqual(expect.any(Number));
  });

  it("bounds history at MAX_UNDO_HISTORY, dropping the oldest entries", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    let history: UndoEntry[] = [];
    for (let i = 0; i < MAX_UNDO_HISTORY + 5; i++) {
      history = pushUndoEntry(history, { beforeState: store, afterState: store, description: `op-${i}` }).history;
    }

    expect(history).toHaveLength(MAX_UNDO_HISTORY);
    expect(history[0].description).toBe("op-5"); // the oldest 5 were dropped
    expect(history[history.length - 1].description).toBe(`op-${MAX_UNDO_HISTORY + 4}`);
  });
});

describe("markUndone / findUndoEntry", () => {
  it("flips only the matching entry's status, leaving others untouched", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const { history: h1, entry: e1 } = pushUndoEntry([], { beforeState: store, afterState: store, description: "A" });
    const { history: h2, entry: e2 } = pushUndoEntry(h1, { beforeState: store, afterState: store, description: "B" });

    const next = markUndone(h2, e1.id);

    expect(findUndoEntry(next, e1.id)?.status).toBe("undone");
    expect(findUndoEntry(next, e2.id)?.status).toBe("active");
  });

  it("findUndoEntry returns undefined for an unknown id", () => {
    expect(findUndoEntry([], "ghost")).toBeUndefined();
  });
});

describe("storesMatch", () => {
  it("is true for two structurally identical stores, independent of key order", () => {
    const a = { version: 1 as const, currentId: "a", workspaces: [{ id: "a", name: "A", tabs: [], createdAt: 1, updatedAt: 2 }] };
    const b = { workspaces: [{ updatedAt: 2, createdAt: 1, tabs: [], name: "A", id: "a" }], currentId: "a", version: 1 as const };
    expect(storesMatch(a, b)).toBe(true);
  });

  it("is false when a nested value differs", () => {
    const a = makeStore([makeWorkspace({ id: "a", name: "A" })], "a");
    const b = makeStore([makeWorkspace({ id: "a", name: "A (renamed)" })], "a");
    expect(storesMatch(a, b)).toBe(false);
  });

  it("is false when array lengths differ", () => {
    const a = makeStore([makeWorkspace({ id: "a" })], "a");
    const b = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    expect(storesMatch(a, b)).toBe(false);
  });
});

describe("attemptUndo", () => {
  it("succeeds and returns beforeState when the current store still matches afterState exactly", () => {
    const before = makeStore([makeWorkspace({ id: "a" })], "a");
    const after = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    const { entry } = pushUndoEntry([], { beforeState: before, afterState: after, description: "Created workspace" });

    const result = attemptUndo(entry, after);

    expect(result).toEqual({ ok: true, store: before });
  });

  it("refuses when the current store no longer matches afterState (a newer change happened)", () => {
    const before = makeStore([makeWorkspace({ id: "a" })], "a");
    const after = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a");
    const { entry } = pushUndoEntry([], { beforeState: before, afterState: after, description: "Created workspace" });

    const driftedCurrent = makeStore(
      [makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" }), makeWorkspace({ id: "c", name: "Manually added" })],
      "a"
    );

    expect(attemptUndo(entry, driftedCurrent)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses an entry that's already been undone", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const { history, entry } = pushUndoEntry([], { beforeState: store, afterState: store, description: "x" });
    const undone = findUndoEntry(markUndone(history, entry.id), entry.id);

    expect(attemptUndo(undone, store)).toEqual({ ok: false, reason: "already-undone" });
  });

  it("refuses a missing entry", () => {
    expect(attemptUndo(undefined, makeStore([makeWorkspace({ id: "a" })], "a"))).toEqual({ ok: false, reason: "not-found" });
  });

  it("supports undoing the latest of several operations without disturbing earlier ones (A → B → C)", () => {
    const s0 = makeStore([makeWorkspace({ id: "a" })], "a"); // initial
    const s1 = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })], "a"); // after A
    const s2 = makeStore([makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" }), makeWorkspace({ id: "c" })], "a"); // after B
    const s3 = makeStore(
      [makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" }), makeWorkspace({ id: "c" }), makeWorkspace({ id: "d" })],
      "a"
    ); // after C

    let history: UndoEntry[] = [];
    let pushed = pushUndoEntry(history, { beforeState: s0, afterState: s1, description: "A" });
    history = pushed.history;
    const entryA = pushed.entry;
    pushed = pushUndoEntry(history, { beforeState: s1, afterState: s2, description: "B" });
    history = pushed.history;
    const entryB = pushed.entry;
    pushed = pushUndoEntry(history, { beforeState: s2, afterState: s3, description: "C" });
    history = pushed.history;
    const entryC = pushed.entry;

    // Undo C: current store is s3, matches C.afterState.
    const undoC = attemptUndo(entryC, s3);
    expect(undoC).toEqual({ ok: true, store: s2 });
    history = markUndone(history, entryC.id);

    // B is now the next available undo: current store is s2 (== B.afterState).
    const currentAfterUndoC = (undoC as { ok: true; store: WorkspaceStore }).store;
    const undoB = attemptUndo(findUndoEntry(history, entryB.id), currentAfterUndoC);
    expect(undoB).toEqual({ ok: true, store: s1 });

    // A was never touched by any of this.
    expect(findUndoEntry(history, entryA.id)?.status).toBe("active");
    expect(findUndoEntry(history, entryA.id)?.beforeState).toBe(s0);
  });
});
