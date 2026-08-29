import { describe, expect, it } from "vitest";
import { createCollection } from "./relations";
import { validateAddTabToCollection } from "./validation";

describe("validateAddTabToCollection", () => {
  it("rejects an unknown collection", () => {
    expect(validateAddTabToCollection([], "ghost", "tab-1", "ws-1")).toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects a tab that doesn't exist", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics");
    expect(validateAddTabToCollection(collections, collection.id, "tab-1", undefined)).toEqual({
      ok: false,
      reason: "tab-not-found",
    });
  });

  it("rejects a tab belonging to a different workspace", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics");
    expect(validateAddTabToCollection(collections, collection.id, "tab-1", "ws-2")).toEqual({
      ok: false,
      reason: "wrong-workspace",
    });
  });

  it("rejects a tab already in the target collection", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics", ["tab-1"]);
    expect(validateAddTabToCollection(collections, collection.id, "tab-1", "ws-1")).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("allows a valid same-workspace tab not yet a member", () => {
    const { collections, collection } = createCollection([], "ws-1", "Physics");
    expect(validateAddTabToCollection(collections, collection.id, "tab-1", "ws-1")).toEqual({ ok: true });
  });

  it("allows a tab currently in a different collection (a move)", () => {
    const { collections: afterFirst, collection: physics } = createCollection([], "ws-1", "Physics", ["tab-1"]);
    const { collections, collection: chem } = createCollection(afterFirst, "ws-1", "Chem");
    void physics;
    expect(validateAddTabToCollection(collections, chem.id, "tab-1", "ws-1")).toEqual({ ok: true });
  });
});
