import { describe, expect, it } from "vitest";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import { buildGraphEdges, buildGraphNodes, buildWorkspaceLookup, edgeKey } from "./relations";
import { DEFAULT_CONNECTION_FILTERS } from "./types";

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://${overrides.id}.example.com`,
    normalizedUrl: `https://${overrides.id}.example.com`,
    domain: `${overrides.id}.example.com`,
    ...overrides,
  };
}

function makeWorkspace(id: string, tabs: Tab[]): Workspace {
  return { id, name: id, tabs, createdAt: 0, updatedAt: 0 };
}

describe("buildGraphNodes", () => {
  it("maps each tab to a node carrying its workspace", () => {
    const tabA = makeTab({ id: "a" });
    const tabB = makeTab({ id: "b" });
    const workspaces = [makeWorkspace("w1", [tabA, tabB])];
    const lookup = buildWorkspaceLookup(workspaces);

    const nodes = buildGraphNodes([tabA, tabB], lookup);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: "a", workspaceId: "w1", workspaceName: "w1" });
  });

  it("skips malformed tab entries instead of crashing", () => {
    const good = makeTab({ id: "a" });
    const bad = { id: 123 } as unknown as Tab;
    const nodes = buildGraphNodes([good, bad], new Map());
    expect(nodes).toHaveLength(1);
  });
});

describe("buildGraphEdges", () => {
  it("connects tabs sharing a domain (chained, not all-pairs)", () => {
    const tabs = [
      makeTab({ id: "a", domain: "github.com" }),
      makeTab({ id: "b", domain: "github.com" }),
      makeTab({ id: "c", domain: "github.com" }),
    ];
    const edges = buildGraphEdges(tabs, new Map(), { ...DEFAULT_CONNECTION_FILTERS }, []);
    // 3 same-domain tabs chain into 2 edges, not 3 (all-pairs would be 3).
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.reasons.includes("domain"))).toBe(true);
  });

  it("does not connect tabs on different domains when only domain filter is on", () => {
    const tabs = [makeTab({ id: "a", domain: "a.com" }), makeTab({ id: "b", domain: "b.com" })];
    const edges = buildGraphEdges(
      tabs,
      new Map(),
      { domain: true, workspace: false, category: false, group: false, manual: false },
      []
    );
    expect(edges).toHaveLength(0);
  });

  it("merges reasons when the same pair matches multiple relationships", () => {
    const tabs = [
      makeTab({ id: "a", domain: "x.com", category: "research" }),
      makeTab({ id: "b", domain: "x.com", category: "research" }),
    ];
    const edges = buildGraphEdges(
      tabs,
      new Map(),
      { domain: true, workspace: false, category: true, group: false, manual: false },
      []
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].reasons.sort()).toEqual(["category", "domain"]);
  });

  it("respects the workspace filter", () => {
    const tabA = makeTab({ id: "a" });
    const tabB = makeTab({ id: "b" });
    const lookup = buildWorkspaceLookup([makeWorkspace("w1", [tabA, tabB])]);
    const edges = buildGraphEdges(
      [tabA, tabB],
      lookup,
      { domain: false, workspace: true, category: false, group: false, manual: false },
      []
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].reasons).toEqual(["workspace"]);
  });

  it("respects the group filter, only linking tabs with an explicit groupId", () => {
    const tabs = [
      makeTab({ id: "a", groupId: "g1" }),
      makeTab({ id: "b", groupId: "g1" }),
      makeTab({ id: "c" }),
    ];
    const edges = buildGraphEdges(
      tabs,
      new Map(),
      { domain: false, workspace: false, category: false, group: true, manual: false },
      []
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("a");
    expect(edges[0].target).toBe("b");
  });

  it("includes manual connections only when both tabs still exist", () => {
    const tabs = [makeTab({ id: "a" }), makeTab({ id: "b" })];
    const edges = buildGraphEdges(
      tabs,
      new Map(),
      { domain: false, workspace: false, category: false, group: false, manual: true },
      [
        { a: "a", b: "b", createdAt: 1 },
        { a: "a", b: "ghost", createdAt: 2 },
      ]
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].reasons).toEqual(["manual"]);
  });

  it("ignores a filter that is turned off even if manual connections exist", () => {
    const tabs = [makeTab({ id: "a" }), makeTab({ id: "b" })];
    const edges = buildGraphEdges(
      tabs,
      new Map(),
      { domain: false, workspace: false, category: false, group: false, manual: false },
      [{ a: "a", b: "b", createdAt: 1 }]
    );
    expect(edges).toHaveLength(0);
  });

  it("produces a deterministic edge id via edgeKey regardless of argument order", () => {
    expect(edgeKey("a", "b")).toBe(edgeKey("b", "a"));
  });
});
