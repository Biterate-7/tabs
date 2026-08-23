import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_LIMIT, rankTabs } from "./rank";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

function makeTab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", ...over };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

describe("rankTabs", () => {
  it("scores an exact title match higher than a mere substring match", () => {
    const workspaces = [
      makeWorkspace({
        id: "a",
        tabs: [
          makeTab("exact", { title: "physics" }),
          makeTab("substring", { title: "Intro to Physics IA" }),
        ],
      }),
    ];

    const results = rankTabs({ workspaces, query: "physics" });

    expect(results.map((r) => r.tabId)).toEqual(["exact", "substring"]);
    expect(results[0].matchReason).toBe("title");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("matches on a keyword substring anywhere in the title", () => {
    const workspaces = [makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Gemini API function calling docs" })] })];
    const results = rankTabs({ workspaces, query: "gemini" });
    expect(results).toHaveLength(1);
    expect(results[0].matchReason).toBe("title");
  });

  it("matches on URL/domain when the title doesn't contain the query", () => {
    const workspaces = [
      makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Untitled page", domain: "github.com", url: "https://github.com/foo/bar" })] }),
    ];
    const results = rankTabs({ workspaces, query: "github" });
    expect(results).toHaveLength(1);
    expect(results[0].matchReason).toBe("url");
  });

  it("matches on the workspace's own name (e.g. 'tabs in Physics IA')", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Physics IA", tabs: [makeTab("1", { title: "Untitled" })] }),
      makeWorkspace({ id: "b", name: "Shopping", tabs: [makeTab("2", { title: "Untitled" })] }),
    ];
    const results = rankTabs({ workspaces, query: "physics ia" });
    expect(results.map((r) => r.tabId)).toEqual(["1"]);
    expect(results[0].matchReason).toBe("workspace");
  });

  it("matches purely semantically when no keyword overlaps at all", () => {
    const workspaces = [makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "S2 star orbit simulation" })] })];
    const results = rankTabs({
      workspaces,
      query: "orbital mechanics",
      semanticHints: [{ tabId: "1", workspaceId: "a", score: 0.82 }],
    });
    expect(results).toHaveLength(1);
    expect(results[0].matchReason).toBe("semantic");
    expect(results[0].score).toBeCloseTo(0.82 * 3, 5);
  });

  it("combines keyword and semantic signals into a higher combined score (hybrid ranking)", () => {
    const workspaces = [
      makeWorkspace({
        id: "a",
        tabs: [
          makeTab("keyword-only", { title: "Physics notes" }),
          makeTab("keyword-and-semantic", { title: "Physics notes" }),
        ],
      }),
    ];
    const results = rankTabs({
      workspaces,
      query: "physics",
      semanticHints: [{ tabId: "keyword-and-semantic", workspaceId: "a", score: 0.9 }],
    });

    const both = results.find((r) => r.tabId === "keyword-and-semantic")!;
    const keywordOnly = results.find((r) => r.tabId === "keyword-only")!;
    expect(both.score).toBeGreaterThan(keywordOnly.score);
    // The literal keyword hit is still the reported reason — more certain than "semantic."
    expect(both.matchReason).toBe("title");
  });

  it("returns nothing when there's no keyword or semantic signal at all", () => {
    const workspaces = [makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Shopping list" })] })];
    expect(rankTabs({ workspaces, query: "quantum computing" })).toEqual([]);
  });

  it("still surfaces a weak match with an honest low score, distinguishable from a strong one", () => {
    const workspaces = [
      makeWorkspace({
        id: "a",
        tabs: [makeTab("weak"), makeTab("strong", { title: "Quantum Computing Basics" })],
      }),
    ];
    const results = rankTabs({
      workspaces,
      query: "quantum computing",
      semanticHints: [{ tabId: "weak", workspaceId: "a", score: 0.51 }],
    });

    expect(results.map((r) => r.tabId)).toEqual(["strong", "weak"]);
    expect(results.find((r) => r.tabId === "weak")!.score).toBeLessThan(results.find((r) => r.tabId === "strong")!.score);
  });

  it("ranks across multiple workspaces together, not just within one", () => {
    const workspaces = [
      makeWorkspace({ id: "a", name: "Physics", tabs: [makeTab("1", { title: "Physics 101" }), makeTab("2", { title: "Physics 201" })] }),
      makeWorkspace({ id: "b", name: "Research", tabs: [makeTab("3", { title: "Physics research notes" })] }),
      makeWorkspace({ id: "c", name: "Random", tabs: [makeTab("4", { title: "Grocery list" })] }),
    ];
    const results = rankTabs({ workspaces, query: "physics" });
    expect(results.map((r) => r.tabId).sort()).toEqual(["1", "2", "3"]);
    expect(new Set(results.map((r) => r.workspaceId))).toEqual(new Set(["a", "b"]));
  });

  it("returns duplicate/near-duplicate tabs as separate results when both match", () => {
    const workspaces = [
      makeWorkspace({
        id: "a",
        tabs: [
          makeTab("dup-1", { title: "Physics IA", isDuplicate: true }),
          makeTab("dup-2", { title: "Physics IA" }),
        ],
      }),
    ];
    const results = rankTabs({ workspaces, query: "physics ia" });
    expect(results.map((r) => r.tabId).sort()).toEqual(["dup-1", "dup-2"]);
  });

  it("leaves groupId/groupName unset — tabs have no group assignment in this version of TabDump", () => {
    const workspaces = [makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics" })] })];
    const results = rankTabs({ workspaces, query: "physics" });
    expect(results[0].groupId).toBeUndefined();
    expect(results[0].groupName).toBeUndefined();
  });

  it("respects the configurable limit and defaults to DEFAULT_SEARCH_LIMIT", () => {
    const tabs = Array.from({ length: DEFAULT_SEARCH_LIMIT + 10 }, (_, i) => makeTab(`t${i}`, { title: `Physics ${i}` }));
    const workspaces = [makeWorkspace({ id: "a", tabs })];

    expect(rankTabs({ workspaces, query: "physics" })).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(rankTabs({ workspaces, query: "physics", limit: 5 })).toHaveLength(5);
  });

  it("never returns a tab from a workspace that wasn't in the given list", () => {
    const included = makeWorkspace({ id: "a", tabs: [makeTab("1", { title: "Physics" })] });
    const results = rankTabs({ workspaces: [included], query: "physics" });
    expect(results.every((r) => r.workspaceId === "a")).toBe(true);
  });
});
