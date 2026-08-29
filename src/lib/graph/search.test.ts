import { describe, expect, it } from "vitest";
import type { Tab } from "@/lib/tabs/types";
import { matchesGraphQuery, searchGraphNodes } from "./search";
import type { GraphNode } from "./types";

function makeNode(overrides: Partial<Tab> & { id: string }, workspaceName = "General"): GraphNode {
  const tab: Tab = {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    ...overrides,
  };
  return { id: tab.id, tab, workspaceId: "w1", workspaceName };
}

describe("matchesGraphQuery", () => {
  it("matches on title, url, domain, workspace, and category", () => {
    const node = makeNode({ id: "a", title: "Physics 101", category: "school" }, "Research");
    expect(matchesGraphQuery(node, "physics")).toBe(true);
    expect(matchesGraphQuery(node, "example.com")).toBe(true);
    expect(matchesGraphQuery(node, "research")).toBe(true);
    expect(matchesGraphQuery(node, "school")).toBe(true);
    expect(matchesGraphQuery(node, "nope")).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(matchesGraphQuery(makeNode({ id: "a" }), "  ")).toBe(true);
  });
});

describe("searchGraphNodes", () => {
  it("returns nothing for an empty query rather than the whole list", () => {
    const nodes = [makeNode({ id: "a", title: "Foo" })];
    expect(searchGraphNodes(nodes, "")).toEqual([]);
  });

  it("filters to matching nodes", () => {
    const nodes = [makeNode({ id: "a", title: "Foo" }), makeNode({ id: "b", title: "Bar" })];
    expect(searchGraphNodes(nodes, "foo").map((n) => n.id)).toEqual(["a"]);
  });
});
