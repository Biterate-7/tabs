import { describe, expect, it } from "vitest";
import { describeAddress } from "./items";
import {
  effectiveDestination,
  excludeExtraCopies,
  includeCopies,
  locate,
  moveItem,
  moveItemToNewGroup,
  renameGroup,
  setDestination,
  summarize,
  ungroup,
  validateProposal,
} from "./edit";
import type { SmartItem, SmartProposal } from "./types";

function item(id: string, url: string, title: string): SmartItem {
  return { id, ...describeAddress(url)!, title };
}

function proposal(): SmartProposal {
  return {
    mode: "open-tabs",
    items: [
      item("a", "https://a.example/1", "Projectile motion"),
      item("b", "https://b.example/1", "Projectile motion lab"),
      item("c", "https://c.example/1", "French Revolution"),
      item("d", "https://d.example/1", "French Revolution timeline"),
      item("e", "https://d.example/1?utm_source=x", "French Revolution timeline"),
      item("f", "https://f.example/1", "Weekend plans"),
    ],
    groups: [
      { id: "group-1", name: "Projectile motion", reason: "", itemIds: ["a", "b"], destination: { kind: "new-subject" } },
      { id: "group-2", name: "French Revolution", reason: "", itemIds: ["c", "d", "e"], destination: { kind: "subject", workspaceId: "history" } },
    ],
    review: ["f"],
    excluded: [],
    duplicates: [{ itemIds: ["d", "e"], exact: true }],
    truncated: 0,
  };
}

/** Every item in exactly one place — the invariant apply relies on. */
function expectAccounted(p: SmartProposal) {
  const places = [...p.groups.flatMap((g) => g.itemIds), ...p.review, ...p.excluded.map((entry) => entry.itemId)];
  expect(places.sort()).toEqual(p.items.map((entry) => entry.id).sort());
}

describe("review edits", () => {
  it("renames a group without touching anything else", () => {
    const next = renameGroup(proposal(), "group-1", "Physics IA");
    expect(next.groups[0]!.name).toBe("Physics IA");
    expect(next.groups[1]).toEqual(proposal().groups[1]);
  });

  it("moves a tab between groups, to 'leave as is', and out of the operation", () => {
    let next = moveItem(proposal(), "a", { kind: "group", groupId: "group-2" });
    expect(locate(next, "a")).toEqual({ kind: "group", groupId: "group-2" });
    expect(next.groups[0]!.itemIds).toEqual(["b"]);
    next = moveItem(next, "b", { kind: "review" });
    expect(next.review).toEqual(["f", "b"]);
    next = moveItem(next, "f", { kind: "excluded" });
    expect(next.excluded).toEqual([{ itemId: "f", reason: "you" }]);
    expectAccounted(next);
  });

  it("ignores moves to a group that does not exist or of an unknown tab", () => {
    const start = proposal();
    expect(moveItem(start, "a", { kind: "group", groupId: "nope" })).toBe(start);
    expect(moveItem(start, "zzz", { kind: "review" })).toBe(start);
  });

  it("starts a new group from one tab, with the right kind of destination", () => {
    const next = moveItemToNewGroup(proposal(), "f");
    expect(next.groups.at(-1)).toMatchObject({ id: "group-3", name: "New group", itemIds: ["f"], destination: { kind: "new-subject" } });
    expectAccounted(next);
    const subjectMode = moveItemToNewGroup({ ...proposal(), mode: "subject" }, "f");
    expect(subjectMode.groups.at(-1)!.destination).toEqual({ kind: "new-collection" });
  });

  it("ungroups a whole group, leaving its tabs as they are", () => {
    const next = ungroup(proposal(), "group-1");
    expect(next.groups.map((g) => g.id)).toEqual(["group-2"]);
    expect(next.review).toEqual(["f", "a", "b"]);
    expectAccounted(next);
  });

  it("takes extra copies of a duplicate out and puts them back, never deleting either", () => {
    let next = excludeExtraCopies(proposal(), ["d", "e"]);
    expect(next.excluded).toEqual([{ itemId: "e", reason: "duplicate" }]);
    expect(next.items).toHaveLength(6);
    next = includeCopies(next, ["d", "e"]);
    expect(locate(next, "e")).toEqual({ kind: "group", groupId: "group-2" });
    expectAccounted(next);
  });

  it("changes a destination", () => {
    const next = setDestination(proposal(), "group-1", { kind: "subject", workspaceId: "physics" });
    expect(next.groups[0]!.destination).toEqual({ kind: "subject", workspaceId: "physics" });
  });

  it("cancelling is simply not applying: edits never touch the original proposal", () => {
    const original = proposal();
    const snapshot = structuredClone(original);
    renameGroup(original, "group-1", "X");
    moveItem(original, "a", { kind: "excluded" });
    ungroup(original, "group-2");
    excludeExtraCopies(original, ["d", "e"]);
    expect(original).toEqual(snapshot);
  });
});

describe("what will change", () => {
  it("counts pages once per destination, new places once, and everything left as is", () => {
    expect(summarize(proposal())).toEqual({ groups: 2, pages: 4, created: 1, existing: 1, unchanged: 1 });
  });

  it("treats a new group named like an existing place as that place", () => {
    const places = [{ id: "physics", name: "Projectile Motion" }];
    expect(effectiveDestination(proposal().groups[0]!, places)).toEqual({ kind: "subject", workspaceId: "physics" });
    expect(summarize(proposal(), places)).toMatchObject({ created: 0, existing: 2 });
  });

  it("flags a group left without a name, but ignores empty groups", () => {
    let next = renameGroup(proposal(), "group-1", "   ");
    expect(validateProposal(next)).toEqual([{ groupId: "group-1", problem: "empty-name" }]);
    next = moveItem(moveItem(next, "a", { kind: "review" }), "b", { kind: "review" });
    expect(validateProposal(next)).toEqual([]);
    expect(summarize(next).groups).toBe(1);
  });
});
