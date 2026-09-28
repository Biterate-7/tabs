// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FOCUS_LIMITS,
  FOCUS_NOTE,
  attachmentsStayIn,
  describeFocus,
  focusFitsSnapshot,
  focusFromAttachments,
  isEmptyFocus,
} from "./focus";
import { createSessionContextRegistry } from "./registry";
import { readSessionContextSnapshot } from "./snapshot";

const RAW = {
  workspace: {
    id: "w1",
    name: "Research",
    createdAt: 1,
    updatedAt: 1,
    tabs: [
      { id: "t1", url: "https://a.example/1", normalizedUrl: "https://a.example/1", domain: "a.example", title: "Paper‮ one" },
      { id: "t2", url: "https://b.example/2", normalizedUrl: "https://b.example/2", domain: "b.example" },
    ],
  },
  collections: [{ id: "c1", workspaceId: "w1", name: "Physics", tabIds: ["t1"], createdAt: 1, updatedAt: 1 }],
  dependencies: [],
};
const SNAPSHOT = readSessionContextSnapshot(RAW, "w1")!;

describe("focus from attachments", () => {
  it("keeps only tab and collection references, once each, within bounds", () => {
    const focus = focusFromAttachments([
      { kind: "workspace", id: "w1", label: "Research" },
      { kind: "tab", id: "t1", label: "a" },
      { kind: "tab", id: "t1", label: "a again" },
      { kind: "collection", id: "c1", label: "Physics" },
      { kind: "relationship", id: "d1", label: "a → b" },
      ...Array.from({ length: 80 }, (_, index) => ({ kind: "tab" as const, id: `x${index}`, label: "x" })),
    ]);
    expect(focus.collectionIds).toEqual(["c1"]);
    expect(focus.tabIds[0]).toBe("t1");
    expect(focus.tabIds).toHaveLength(FOCUS_LIMITS.tabs);
    expect(new Set(focus.tabIds).size).toBe(focus.tabIds.length);
  });

  it("is empty for context naming no tab or collection", () => {
    expect(isEmptyFocus(focusFromAttachments([{ kind: "workspace", id: "w1", label: "Research" }]))).toBe(true);
    expect(isEmptyFocus(undefined)).toBe(true);
  });
});

describe("staying inside one workspace", () => {
  it("allows only the session's own workspace to be named", () => {
    expect(attachmentsStayIn([{ kind: "workspace", id: "w1", label: "R" }, { kind: "tab", id: "t9", label: "?" }], "w1")).toBe(true);
    expect(attachmentsStayIn([{ kind: "workspace", id: "w2", label: "Other" }], "w1")).toBe(false);
  });

  it("finds every reference in the bound snapshot, or fails closed", () => {
    expect(focusFitsSnapshot(SNAPSHOT, { tabIds: ["t1", "t2"], collectionIds: ["c1"] })).toBe(true);
    expect(focusFitsSnapshot(SNAPSHOT, { tabIds: ["t1", "elsewhere"], collectionIds: [] })).toBe(false);
    expect(focusFitsSnapshot(SNAPSHOT, { tabIds: [], collectionIds: ["c-foreign"] })).toBe(false);
  });
});

describe("focus as an agent reads it", () => {
  it("comes from the bound snapshot, sanitized, and drops what is gone", () => {
    const view = describeFocus(SNAPSHOT, { tabIds: ["t1", "t2", "gone"], collectionIds: ["c1", "gone"] }, { tabs: true })!;
    expect(view.tabs).toEqual([
      { tabId: "t1", title: "Paper one", domain: "a.example" },
      // No title: named by its site, never left blank.
      { tabId: "t2", title: "b.example", domain: "b.example" },
    ]);
    expect(view.collections).toEqual([{ collectionId: "c1", name: "Physics", tabCount: 1 }]);
    expect(view.note).toBe(FOCUS_NOTE);
  });

  it("names no tab without tabs.read, and says how many there were", () => {
    const view = describeFocus(SNAPSHOT, { tabIds: ["t1"], collectionIds: ["c1"] }, { tabs: false })!;
    expect(view.tabs).toEqual([]);
    expect(view.hiddenTabCount).toBe(1);
    expect(view.collections).toHaveLength(1);
  });

  it("is nothing when nothing it named still exists", () => {
    expect(describeFocus(SNAPSHOT, { tabIds: ["gone"], collectionIds: [] }, { tabs: true })).toBeUndefined();
    expect(describeFocus(SNAPSHOT, undefined, { tabs: true })).toBeUndefined();
  });
});

describe("the registry's focus", () => {
  async function bound() {
    const registry = createSessionContextRegistry({});
    await registry.bind({ sessionId: "s1", ownerId: "local", workspaceId: "w1", access: "read", snapshot: RAW });
    return registry;
  }

  it("records a focus that fits, and never moves the version", async () => {
    const registry = await bound();
    expect(registry.setFocus("s1", { tabIds: ["t1", "t1"], collectionIds: ["c1"] })).toBe(true);
    expect(registry.focus("s1")).toEqual({ tabIds: ["t1"], collectionIds: ["c1"] });
    expect(registry.binding("s1")?.version).toBe(1);
  });

  it("refuses one that reaches outside, and keeps what it had", async () => {
    const registry = await bound();
    registry.setFocus("s1", { tabIds: ["t1"], collectionIds: [] });
    expect(registry.focusFits("s1", { tabIds: ["t-other"], collectionIds: [] })).toBe(false);
    expect(registry.setFocus("s1", { tabIds: ["t2", "t-other"], collectionIds: [] })).toBe(false);
    expect(registry.focus("s1")).toEqual({ tabIds: ["t1"], collectionIds: [] });
  });

  it("has none for an unbound session, clears on an empty focus, and forgets it on release", async () => {
    const registry = await bound();
    expect(registry.setFocus("nobody", { tabIds: ["t1"], collectionIds: [] })).toBe(false);
    expect(registry.focus("nobody")).toBeUndefined();

    registry.setFocus("s1", { tabIds: ["t1"], collectionIds: [] });
    registry.setFocus("s1", { tabIds: [], collectionIds: [] });
    expect(registry.focus("s1")).toBeUndefined();

    registry.setFocus("s1", { tabIds: ["t2"], collectionIds: [] });
    registry.release("s1");
    expect(registry.focus("s1")).toBeUndefined();
  });
});
