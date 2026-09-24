import { describe, expect, it } from "vitest";
import { applyCollectionBatch } from "./batch";
import type { CollectionBatchOperation } from "./batch";
import type { Collection } from "./types";

/**
 * A batch of collection changes is all or nothing (Phase J.5): every
 * operation holds against the state before it, or the caller gets nothing
 * to commit and the index of the one that did not.
 */

const SCOPE = { workspaceId: "w1", tabIds: new Set(["a", "b", "c", "d"]) };

function base(): Collection[] {
  return [
    { id: "c1", workspaceId: "w1", name: "Inbox", tabIds: ["a", "b"], createdAt: 1, updatedAt: 1 },
    { id: "c-other", workspaceId: "w2", name: "Elsewhere", tabIds: ["z"], createdAt: 1, updatedAt: 1 },
  ];
}

describe("applyCollectionBatch", () => {
  it("applies every operation in order, moving tabs out of where they were, and reports what it created and touched", () => {
    const before = base();
    const snapshot = JSON.stringify(before);
    const result = applyCollectionBatch(
      before,
      SCOPE,
      [
        { kind: "create_collection", name: " Research ", tabIds: ["a", "c"] },
        { kind: "rename_collection", collectionId: "c1", name: "Reading" },
        { kind: "add_tabs_to_collection", collectionId: "c1", tabIds: ["d"] },
      ],
      500
    );
    if (!result.ok) throw new Error("expected ok");
    const research = result.collections.find((collection) => collection.id === result.created[0])!;
    expect(research).toMatchObject({ workspaceId: "w1", name: "Research", tabIds: ["a", "c"], createdAt: 500 });
    expect(result.collections.find((collection) => collection.id === "c1")).toMatchObject({ name: "Reading", tabIds: ["b", "d"] });
    expect(result.created).toHaveLength(1);
    expect(new Set(result.touched)).toEqual(new Set([research.id, "c1"]));
    // Another workspace's collection is untouched, and the input was not mutated.
    expect(result.collections.find((collection) => collection.id === "c-other")).toEqual(before[1]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("commits nothing when any operation fails, and says which", () => {
    const cases: [CollectionBatchOperation[], number, string][] = [
      [[{ kind: "create_collection", name: "Fine", tabIds: ["a"] }, { kind: "add_tabs_to_collection", collectionId: "c-other", tabIds: ["b"] }], 1, "unknown_collection"],
      [[{ kind: "rename_collection", collectionId: "c1", name: "   " }], 0, "empty_name"],
      [[{ kind: "create_collection", name: "X", tabIds: ["z"] }], 0, "unknown_tab"],
      [[{ kind: "create_collection", name: "X", tabIds: [] }], 0, "no_tabs"],
      [[{ kind: "add_tabs_to_collection", collectionId: "missing", tabIds: ["a"] }], 0, "unknown_collection"],
      [[{ kind: "delete_collection", collectionId: "c1" } as unknown as CollectionBatchOperation], 0, "unknown_kind"],
    ];
    for (const [operations, failedAt, reason] of cases) {
      expect(applyCollectionBatch(base(), SCOPE, operations), JSON.stringify(operations)).toEqual({ ok: false, failedAt, reason });
    }
  });
});
