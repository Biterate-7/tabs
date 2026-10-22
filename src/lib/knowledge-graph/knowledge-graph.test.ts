import { describe, expect, it } from "vitest";
import { adjacency, buildKnowledgeGraph, itemNodeId, projectNodeId, sessionNodeId } from "./build";
import { createKnowledgeLayout, layoutKnowledgeGraph, territoryRadius, LARGE_GRAPH } from "./layout";
import { fitCamera, mixCamera, nodeInDirection, searchNodes, SpatialGrid, zoomAt } from "./view";
import type { Tab } from "@/lib/tabs/types";
import type { ProjectNote } from "@/lib/notes/notes";
import type { TabSession } from "@/lib/sessions/types";
import type { Workspace } from "@/lib/workspace/types";

const T = 1_700_000_000_000;

function source(id: string, url: string, title: string, kind: "webpage" | "conversation" | "pdf" = "webpage", at = T): Tab {
  return {
    id,
    url,
    normalizedUrl: url,
    domain: new URL(url).hostname,
    title,
    resource: { kind, origin: "extension", status: "ready", addedAt: at, updatedAt: at, content: { chars: 100, extractedAt: at } },
  };
}

function note(id: string, kind: ProjectNote["kind"], title: string, extra: Partial<ProjectNote> = {}): ProjectNote {
  return { id, kind, title, origin: "manual", createdAt: T, updatedAt: T, contentHash: `h-${id}`, chars: 10, ...extra };
}

function workspace(id: string, name: string, tabs: Tab[], notes: ProjectNote[] = []): Workspace {
  return { id, name, tabs, notes, createdAt: T, updatedAt: T };
}

const PAPER = "https://example.org/paper";

const thesis = workspace(
  "w1",
  "Thesis",
  [source("t1", PAPER, "The paper"), source("t2", "https://chatgpt.com/c/abcdef12-3456", "Methods chat", "conversation"), source("t3", "https://other.org/a", "Other")],
  [note("n1", "excerpt", "A quote", { sourceUrl: PAPER }), note("n2", "file", "data.pdf", { file: { name: "data.pdf", format: "pdf", size: 10, status: "ready" } }), note("n3", "note", "Plan")]
);
const launch = workspace("w2", "Launch", [source("t4", `${PAPER}?utm_source=x`, "The paper again"), source("t5", "https://chatgpt.com/c/zzzzzzzz-9999", "Another chat", "conversation")]);
const lonely = workspace("w3", "Empty project", []);

const session = (id: string, tabs: string[], workspaceId?: string): TabSession => ({
  id,
  name: `Session ${id}`,
  tabs: tabs.map((url, i) => ({ id: `${id}-${i}`, url, title: url })),
  createdAt: T,
  updatedAt: T,
  revision: 1,
  ...(workspaceId ? { workspaceId } : {}),
});

describe("buildKnowledgeGraph", () => {
  const graph = buildKnowledgeGraph({ workspaces: [thesis, launch, lonely], sessions: [session("s1", [PAPER, "https://news.example/"], "w1"), session("s2", ["https://nothing.example/"])] });
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesOf = (kind: string) => graph.edges.filter((edge) => edge.kind === kind);

  it("makes one node per project, item and session, with ids derived from the records", () => {
    expect(byId.get(projectNodeId("w1"))?.label).toBe("Thesis");
    expect(byId.get(itemNodeId("w1", "s:t2"))?.kind).toBe("conversation");
    expect(byId.get(itemNodeId("w1", "n:n2"))?.kind).toBe("file");
    expect(byId.get(itemNodeId("w1", "n:n1"))?.kind).toBe("note");
    expect(byId.get(itemNodeId("w1", "s:t1"))?.kind).toBe("source");
    expect(byId.get(sessionNodeId("s1"))?.tabCount).toBe(2);
    expect(graph.nodes).toHaveLength(3 + 6 + 2 + 2);
  });

  it("is deterministic", () => {
    const again = buildKnowledgeGraph({ workspaces: [thesis, launch, lonely], sessions: [session("s1", [PAPER, "https://news.example/"], "w1"), session("s2", ["https://nothing.example/"])] });
    expect(again).toEqual(graph);
  });

  it("connects every item to its own project, and nothing to a project it is not in", () => {
    for (const node of graph.nodes) {
      if (node.kind === "project" || node.kind === "session") continue;
      const contains = graph.edges.filter((edge) => edge.kind === "contains" && edge.target === node.id);
      expect(contains).toEqual([expect.objectContaining({ source: projectNodeId(node.projectId!) })]);
    }
  });

  it("links the same address saved in two projects, ignoring tracking parameters", () => {
    expect(edgesOf("same-source").map((edge) => [edge.source, edge.target].sort())).toEqual([[itemNodeId("w1", "s:t1"), itemNodeId("w2", "s:t4")].sort()]);
  });

  it("never treats two different conversations from one AI app as one source", () => {
    const chats = [itemNodeId("w1", "s:t2"), itemNodeId("w2", "s:t5")];
    expect(graph.edges.some((edge) => chats.includes(edge.source) && chats.includes(edge.target))).toBe(false);
  });

  it("links an excerpt to the saved page it quotes, wherever that page is", () => {
    const targets = edgesOf("excerpt-of").map((edge) => (edge.source === itemNodeId("w1", "n:n1") ? edge.target : edge.source));
    expect(targets.sort()).toEqual([itemNodeId("w1", "s:t1"), itemNodeId("w2", "s:t4")].sort());
  });

  it("links a session to its project and to saved items it has open, and leaves an unrelated session isolated", () => {
    expect(edgesOf("session-project")).toEqual([expect.objectContaining({ source: projectNodeId("w1"), target: sessionNodeId("s1") })]);
    expect(edgesOf("session-source").length).toBe(2);
    const neighbours = adjacency(graph);
    expect(neighbours.get(sessionNodeId("s2"))?.size).toBe(0);
    expect(neighbours.get(projectNodeId("w3"))?.size).toBe(0);
  });

  it("ignores a session's project when that project no longer exists", () => {
    const g = buildKnowledgeGraph({ workspaces: [lonely], sessions: [session("s9", [], "deleted")] });
    expect(g.nodes.find((node) => node.id === sessionNodeId("s9"))?.projectId).toBeUndefined();
    expect(g.edges).toEqual([]);
  });

  it("chains, rather than fully connects, one address saved in many projects", () => {
    const many = Array.from({ length: 8 }, (_, i) => workspace(`m${i}`, `P${i}`, [source(`x${i}`, PAPER, "Same")]));
    const g = buildKnowledgeGraph({ workspaces: many });
    expect(g.edges.filter((edge) => edge.kind === "same-source")).toHaveLength(7);
  });
});

describe("layout", () => {
  const graph = buildKnowledgeGraph({ workspaces: [thesis, launch, lonely], sessions: [session("s1", [PAPER], "w1"), session("s2", ["https://n.example/"])] });

  it("places every node at a finite position, the same way every time", () => {
    const a = layoutKnowledgeGraph(graph);
    const b = layoutKnowledgeGraph(graph);
    expect(a).toEqual(b);
    for (const node of graph.nodes) {
      expect(Number.isFinite(a[node.id]!.x)).toBe(true);
      expect(Number.isFinite(a[node.id]!.y)).toBe(true);
    }
  });

  it("keeps a project's items in its territory and projects apart", () => {
    const at = layoutKnowledgeGraph(graph);
    for (const node of graph.nodes) {
      if (node.kind === "project" || !node.projectId) continue;
      const home = at[projectNodeId(node.projectId)]!;
      const items = graph.nodes.filter((other) => other.projectId === node.projectId && other.kind !== "project").length;
      expect(Math.hypot(at[node.id]!.x - home.x, at[node.id]!.y - home.y)).toBeLessThan(territoryRadius(items) * 1.25);
    }
    const p1 = at[projectNodeId("w1")]!;
    const p2 = at[projectNodeId("w2")]!;
    expect(Math.hypot(p1.x - p2.x, p1.y - p2.y)).toBeGreaterThan(territoryRadius(3));
  });

  it("leaves known nodes where they were when one item is added", () => {
    const before = layoutKnowledgeGraph(graph);
    const grown = buildKnowledgeGraph({
      workspaces: [{ ...thesis, notes: [...(thesis.notes ?? []), note("n9", "note", "New one")] }, launch, lonely],
      sessions: [session("s1", [PAPER], "w1"), session("s2", ["https://n.example/"])],
    });
    const after = layoutKnowledgeGraph(grown, before);
    expect(after[itemNodeId("w1", "n:n9")]).toBeDefined();
    let moved = 0;
    for (const node of graph.nodes) moved = Math.max(moved, Math.hypot(after[node.id]!.x - before[node.id]!.x, after[node.id]!.y - before[node.id]!.y));
    // Nudged aside at most — never relaid out.
    expect(moved).toBeLessThan(40);
    expect(after[projectNodeId("w1")]).toEqual(before[projectNodeId("w1")]);
  });

  it("lays out a large graph in bounded time and in slices", () => {
    const big = Array.from({ length: 30 }, (_, p) =>
      workspace(
        `big${p}`,
        `Project ${p}`,
        Array.from({ length: 70 }, (_, i) => source(`b${p}-${i}`, `https://site${i % 40}.example/${p}/${i}`, `Item ${i}`, i % 3 === 0 ? "conversation" : "webpage", T - i * 1000))
      )
    );
    const g = buildKnowledgeGraph({ workspaces: big });
    expect(g.nodes.length).toBeGreaterThan(LARGE_GRAPH);
    const started = performance.now();
    const layout = createKnowledgeLayout(g);
    let slices = 0;
    while (!layout.step(40)) slices += 1;
    const elapsed = performance.now() - started;
    expect(slices).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(20_000);
    const positions = layout.positions();
    expect(Object.keys(positions)).toHaveLength(g.nodes.length);
  }, 30_000);
});

describe("view helpers", () => {
  const viewport = { width: 1000, height: 800 };

  it("fits points into the free part of the viewport", () => {
    const camera = fitCamera([{ x: 0, y: 0 }, { x: 200, y: 100 }], viewport, { padding: 0, insets: { right: 400 }, maxZoom: 10 });
    expect(camera.k).toBeCloseTo(3, 5);
    // Centred in the 600px left of the panel: the bbox centre sits 200px left of the viewport centre.
    expect((100 - camera.x) * camera.k).toBeCloseTo(-200, 5);
  });

  it("zooms about the pointer", () => {
    const camera = { x: 0, y: 0, k: 1 };
    const next = zoomAt(camera, { x: 700, y: 400 }, 2, viewport);
    // The world point under the pointer (200, 0) stays under it.
    expect((200 - next.x) * next.k + 500).toBeCloseTo(700, 5);
  });

  it("eases cameras without overshoot", () => {
    const from = { x: 0, y: 0, k: 1 };
    const to = { x: 100, y: 0, k: 4 };
    for (let t = 0; t <= 1; t += 0.1) {
      const c = mixCamera(from, to, t);
      expect(c.x).toBeLessThanOrEqual(100.0001);
      expect(c.k).toBeLessThanOrEqual(4.0001);
    }
    expect(mixCamera(from, to, 1)).toEqual(to);
  });

  it("hit-tests through the grid", () => {
    const grid = SpatialGrid.from([
      { id: "a", x: 0, y: 0, r: 5 },
      { id: "b", x: 100, y: 100, r: 20 },
    ]);
    expect(grid.hit(3, 3, 2)).toBe("a");
    expect(grid.hit(118, 100, 1)).toBe("b");
    expect(grid.hit(50, 50, 2)).toBeUndefined();
  });

  it("moves by arrow key to the nearest node ahead", () => {
    const positions = { a: { x: 0, y: 0 }, right: { x: 100, y: 10 }, far: { x: 300, y: 0 }, up: { x: 0, y: -50 } };
    expect(nodeInDirection("a", "right", positions, Object.keys(positions))).toBe("right");
    expect(nodeInDirection("a", "up", positions, Object.keys(positions))).toBe("up");
    expect(nodeInDirection("a", "left", positions, Object.keys(positions))).toBeUndefined();
  });

  it("searches names, then projects and AI apps", () => {
    const graph = buildKnowledgeGraph({ workspaces: [thesis, launch] });
    const names = new Map([["w1", "Thesis"], ["w2", "Launch"]]);
    expect(searchNodes(graph.nodes, "methods", (id) => names.get(id))[0]?.label).toBe("Methods chat");
    expect(searchNodes(graph.nodes, "chatgpt", (id) => names.get(id)).map((node) => node.label).sort()).toEqual(["Another chat", "Methods chat"]);
    expect(searchNodes(graph.nodes, "launch paper", (id) => names.get(id)).map((node) => node.label)).toEqual(["The paper again"]);
  });
});

describe("saved tabs and the relationships people make between them", () => {
  const plain = (id: string, url: string, title: string): Tab => ({ id, url, normalizedUrl: url, domain: new URL(url).hostname, title, createdAt: T });
  const dumps = workspace("w4", "Reading", [plain("d1", "https://github.com/acme/repo", "acme/repo"), plain("d2", PAPER, "Paper, as a tab"), plain("d3", "https://blog.example/post", "A post")]);
  const all = [thesis, launch, dumps];

  it("makes one node per saved tab, in its own project, under the id a source would have", () => {
    const graph = buildKnowledgeGraph({ workspaces: all });
    const node = graph.nodes.find((entry) => entry.id === itemNodeId("w4", "s:d1"));
    expect(node).toMatchObject({ kind: "source", savedTab: true, projectId: "w4", label: "acme/repo" });
    expect(graph.nodes.filter((entry) => entry.savedTab)).toHaveLength(3);
    // No tab appears twice, and a project counts what it holds.
    expect(new Set(graph.nodes.map((entry) => entry.id)).size).toBe(graph.nodes.length);
    expect(graph.nodes.find((entry) => entry.id === projectNodeId("w4"))?.size).toBe(3);
    // A source Hubble has read is not also a saved tab.
    expect(graph.nodes.find((entry) => entry.id === itemNodeId("w1", "s:t1"))?.savedTab).toBeUndefined();
  });

  it("connects a saved tab to the same page saved as a source elsewhere", () => {
    const graph = buildKnowledgeGraph({ workspaces: all });
    const tab = itemNodeId("w4", "s:d2");
    expect(graph.edges.some((edge) => edge.kind === "same-source" && (edge.source === tab || edge.target === tab))).toBe(true);
  });

  it("draws links and dependencies by tab id, directed for dependencies, and drops any whose tab is gone", () => {
    const graph = buildKnowledgeGraph({
      workspaces: all,
      links: [{ a: "d1", b: "t2", createdAt: T }, { a: "d1", b: "gone", createdAt: T }],
      dependencies: [{ id: "dep-d3::d1", parentTabId: "d3", childTabId: "d1", type: "reference", createdAt: T }, { id: "dep-x::d1", parentTabId: "x", childTabId: "d1", createdAt: T }],
    });
    const linked = graph.edges.filter((edge) => edge.kind === "linked");
    expect(linked).toHaveLength(1);
    expect([linked[0]!.source, linked[0]!.target].sort()).toEqual([itemNodeId("w1", "s:t2"), itemNodeId("w4", "s:d1")].sort());
    const depends = graph.edges.filter((edge) => edge.kind === "depends-on");
    expect(depends).toEqual([{ id: `depends-on:${itemNodeId("w4", "s:d3")}|${itemNodeId("w4", "s:d1")}`, source: itemNodeId("w4", "s:d3"), target: itemNodeId("w4", "s:d1"), kind: "depends-on", dependency: { id: "dep-d3::d1", type: "reference" } }]);
  });

  it("gives an undated tab its project's date, never the epoch", () => {
    const undated = workspace("w5", "Old", [{ id: "u1", url: "https://old.example/", normalizedUrl: "https://old.example/", domain: "old.example", title: "Old" }]);
    const graph = buildKnowledgeGraph({ workspaces: [undated] });
    expect(graph.nodes.find((entry) => entry.id === itemNodeId("w5", "s:u1"))?.at).toBe(T);
  });
});
