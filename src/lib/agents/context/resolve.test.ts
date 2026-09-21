import { describe, expect, it } from "vitest";
import { resolveContext } from "./resolve";
import { clampLimits, DEFAULT_CONTEXT_LIMITS, MAX_CONTEXT_LIMITS } from "./limits";
import { itemsOfType } from "./types";
import {
  fixtureWorld,
  largeWorld,
  scopeA,
  scopeAWithProject,
  T0,
} from "./__fixtures__/world";
import type { AgentContextRequest, AgentContextSnapshot } from "./types";

const OPTIONS = { now: () => T0 + 60_000, createSnapshotId: () => "snap-1" };

function resolve(request: AgentContextRequest, world = fixtureWorld()): AgentContextSnapshot {
  const result = resolveContext(request, world, OPTIONS);
  if (!result.ok) throw new Error(`expected resolution, got ${result.reason}`);
  return result.snapshot;
}

function omissionFor(snapshot: AgentContextSnapshot, sourceType: string, reason: string) {
  return snapshot.omissions.find((o) => o.sourceType === sourceType && o.reason === reason);
}

describe("request validation", () => {
  it("refuses a request with no sources", () => {
    const result = resolveContext(
      { scope: scopeA(), sources: [] },
      fixtureWorld(),
      OPTIONS
    );
    expect(result).toEqual({ ok: false, reason: "invalid-request" });
  });

  it("refuses a scope naming no workspace", () => {
    const result = resolveContext(
      { scope: { ownerId: "user-1", workspaceIds: [], projectIds: [] }, sources: ["tab"] },
      fixtureWorld(),
      OPTIONS
    );
    expect(result).toEqual({ ok: false, reason: "invalid-request" });
  });

  it("has no way to express 'everything'", () => {
    // Asserted against the type's own shape rather than by trying a magic
    // value: the point is that no such value exists to try.
    const request: AgentContextRequest = { scope: scopeA(), sources: ["tab"] };
    expect(Object.keys(request)).not.toContain("all");
    expect(Object.keys(request)).not.toContain("includeEverything");
  });
});

describe("workspace context", () => {
  it("resolves a workspace to bounded metadata", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["workspace"],
      workspaceIds: ["ws-a"],
    });

    expect(itemsOfType(snapshot, "workspace")).toEqual([
      {
        sourceType: "workspace",
        sourceId: "ws-a",
        label: "Research",
        tabCount: 5,
        collectionCount: 1,
        createdAt: T0,
        updatedAt: T0 + 1_000,
      },
    ]);
  });

  it("omits a workspace outside the scope rather than resolving it", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["workspace"],
      workspaceIds: ["ws-a", "ws-b"],
    });

    expect(itemsOfType(snapshot, "workspace").map((w) => w.sourceId)).toEqual(["ws-a"]);
    expect(omissionFor(snapshot, "workspace", "out-of-scope")).toMatchObject({
      count: 1,
      sourceIds: ["ws-b"],
    });
  });

  it("reports a workspace that no longer exists as not-found, not as empty", () => {
    const snapshot = resolve({
      scope: { ownerId: "user-1", workspaceIds: ["ws-a", "ws-gone"], projectIds: [] },
      sources: ["workspace"],
      workspaceIds: ["ws-gone"],
    });

    expect(snapshot.items).toEqual([]);
    expect(omissionFor(snapshot, "workspace", "not-found")).toMatchObject({ count: 1 });
  });
});

describe("tab context", () => {
  it("resolves the tabs of a requested workspace", () => {
    const snapshot = resolve({ scope: scopeA(), sources: ["tab"], workspaceIds: ["ws-a"] });
    expect(itemsOfType(snapshot, "tab").map((t) => t.sourceId)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });

  it("carries no page content, only references", () => {
    const [first] = itemsOfType(
      resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["a1"] }),
      "tab"
    );

    for (const forbidden of ["content", "body", "html", "text", "snapshot", "favicon"]) {
      expect(Object.keys(first)).not.toContain(forbidden);
    }
  });

  it("withholds notes unless they were explicitly asked for", () => {
    const without = itemsOfType(
      resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["a1"] }),
      "tab"
    )[0];
    expect(without.note).toBeUndefined();

    const withNotes = itemsOfType(
      resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["a1"], includeNotes: true }),
      "tab"
    )[0];
    expect(withNotes.note).toBe("Ask ops before the Friday push");
  });

  it("strips credentials out of a URL before it can reach an agent", () => {
    const [item] = itemsOfType(
      resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["a2"] }),
      "tab"
    );

    expect(item.url).not.toContain("hunter2");
    expect(item.url).not.toContain("alice");
    expect(item.url).not.toContain("sk-live-SECRET");
    expect(item.url).not.toContain("eyJhbG");
    expect(item.urlRedacted).toBe(true);
    // The non-secret parameter survives, so redaction is targeted rather
    // than a blanket drop of the query.
    expect(item.url).toContain("page=2");
  });

  it("refuses a tab in another workspace even when named directly", () => {
    const snapshot = resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["b1"] });

    expect(snapshot.items).toEqual([]);
    expect(omissionFor(snapshot, "tab", "out-of-scope")).toMatchObject({ sourceIds: ["b1"] });
  });

  it("reports ids given for a source that was not requested", () => {
    const snapshot = resolve({ scope: scopeA(), sources: ["workspace"], tabIds: ["a1"] });
    expect(omissionFor(snapshot, "tab", "source-not-requested")).toMatchObject({ count: 1 });
  });

  it("does not report tab ids that seeded a relationship or graph request", () => {
    // They were honoured — as the set to work outward from, not as tab
    // items. Reporting them would put a false entry in the audit trail.
    for (const source of ["relationship", "graph"] as const) {
      const snapshot = resolve({
        scope: scopeA(),
        sources: [source],
        tabIds: ["a3"],
        graph: { centerTabIds: ["a3"], depth: 1 },
      });
      expect(omissionFor(snapshot, "tab", "source-not-requested")).toBeUndefined();
    }
  });
});

describe("collection context", () => {
  it("expands a collection into bounded member references", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["collection"],
      collectionIds: ["col-a1"],
    });

    expect(itemsOfType(snapshot, "collection")).toEqual([
      {
        sourceType: "collection",
        sourceId: "col-a1",
        label: "Docs to read",
        workspaceId: "ws-a",
        tabIds: ["a1", "a2"],
        memberCount: 2,
        membersTruncated: false,
      },
    ]);
  });

  it("does not expand members into tab items on its own", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["collection"],
      collectionIds: ["col-a1"],
    });
    expect(itemsOfType(snapshot, "tab")).toEqual([]);
  });

  it("refuses another workspace's collection", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["collection"],
      collectionIds: ["col-b1"],
    });
    expect(snapshot.items).toEqual([]);
    expect(omissionFor(snapshot, "collection", "out-of-scope")).toBeDefined();
  });

  it("bounds the member list and says it did", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["collection"],
      collectionIds: ["col-a1"],
      limits: { maxCollectionMembers: 1 },
    });

    const [collection] = itemsOfType(snapshot, "collection");
    expect(collection.tabIds).toEqual(["a1"]);
    expect(collection.membersTruncated).toBe(true);
    expect(collection.memberCount).toBe(2);
    expect(omissionFor(snapshot, "collection", "limit-collection-members")).toMatchObject({
      count: 1,
    });
  });

  it("only points a tab at collections the same request resolved", () => {
    // The tab is in col-a1, but col-a1 was not requested. Naming it anyway
    // would tell the agent a collection exists that it was not given.
    const [tab] = itemsOfType(
      resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["a1"] }),
      "tab"
    );
    expect(tab.collectionIds).toEqual([]);

    const both = resolve({
      scope: scopeA(),
      sources: ["tab", "collection"],
      tabIds: ["a1"],
      collectionIds: ["col-a1"],
    });
    expect(itemsOfType(both, "tab")[0].collectionIds).toEqual(["col-a1"]);
  });
});

describe("relationship context", () => {
  it("resolves a dependency whose endpoints are both in scope", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["relationship"],
      workspaceIds: ["ws-a"],
    });

    expect(itemsOfType(snapshot, "relationship")).toEqual([
      {
        sourceType: "relationship",
        sourceId: "dep-1",
        label: "Why we moved off cron → Deployment guide",
        relation: "depends-on",
        fromTabId: "a3",
        toTabId: "a1",
        kind: "reference",
      },
    ]);
  });

  it("drops a relationship that points out of the scope instead of following it", () => {
    // dep-2 is a1 → b1. Following it would be the expansion this rule exists
    // to prevent: attaching workspace A must not reach workspace B because
    // the two happen to be linked.
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["relationship", "tab"],
      workspaceIds: ["ws-a"],
    });

    expect(itemsOfType(snapshot, "relationship").map((r) => r.sourceId)).toEqual(["dep-1"]);
    expect(omissionFor(snapshot, "relationship", "out-of-scope")).toMatchObject({
      sourceIds: ["dep-2"],
    });

    const everything = JSON.stringify(snapshot);
    expect(everything).not.toContain("b1");
    expect(everything).not.toContain("bank.example.com");
  });
});

describe("graph context", () => {
  it("bounds expansion by depth", () => {
    const depthOne = itemsOfType(
      resolve({
        scope: scopeA(),
        sources: ["graph"],
        workspaceIds: ["ws-a"],
        graph: { centerTabIds: ["a3"], depth: 1 },
      }),
      "graph"
    )[0];

    // a3 shares no domain with anything and is linked only by the
    // workspace edge chain, so one hop is a small, checkable set.
    expect(depthOne.depth).toBe(1);
    expect(depthOne.nodes.every((node) => node.distance <= 1)).toBe(true);
    expect(depthOne.nodes.some((node) => node.tabId === "a3")).toBe(true);
  });

  it("returns only the centre at depth 0", () => {
    const item = itemsOfType(
      resolve({
        scope: scopeA(),
        sources: ["graph"],
        workspaceIds: ["ws-a"],
        graph: { centerTabIds: ["a1"], depth: 0 },
      }),
      "graph"
    )[0];

    expect(item.nodes.map((n) => n.tabId)).toEqual(["a1"]);
    expect(item.edges).toEqual([]);
  });

  it("terminates on a cycle", () => {
    // a1 ↔ a4 ↔ a5 ↔ a1. If traversal did not carry a visited set this
    // would not return at all.
    const item = itemsOfType(
      resolve({
        scope: scopeA(),
        sources: ["graph"],
        workspaceIds: ["ws-a"],
        graph: { centerTabIds: ["a4"], depth: 3 },
      }),
      "graph"
    )[0];

    const ids = item.nodes.map((n) => n.tabId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(5);
  });

  it("caps nodes and reports the cap", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["graph"],
      workspaceIds: ["ws-a"],
      graph: { centerTabIds: ["a1"], depth: 3 },
      limits: { maxGraphNodes: 2 },
    });

    const item = itemsOfType(snapshot, "graph")[0];
    expect(item.nodes).toHaveLength(2);
    expect(item.nodesTruncated).toBe(true);
    expect(omissionFor(snapshot, "graph", "limit-graph-nodes")).toBeDefined();
  });

  it("caps edges and keeps the subgraph coherent", () => {
    const item = itemsOfType(
      resolve({
        scope: scopeA(),
        sources: ["graph"],
        workspaceIds: ["ws-a"],
        graph: { centerTabIds: ["a1"], depth: 3 },
        limits: { maxGraphEdges: 1 },
      }),
      "graph"
    )[0];

    expect(item.edges).toHaveLength(1);
    const nodeIds = new Set(item.nodes.map((n) => n.tabId));
    // Every surviving edge points at surviving nodes. An edge to a node
    // that was cut would be a dangling reference an agent could not resolve.
    for (const edge of item.edges) {
      expect(nodeIds.has(edge.fromTabId)).toBe(true);
      expect(nodeIds.has(edge.toTabId)).toBe(true);
    }
  });

  it("never walks out of the scope, whatever the depth", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["graph"],
      workspaceIds: ["ws-a"],
      graph: { centerTabIds: ["a1"], depth: 3 },
      limits: { maxGraphNodes: MAX_CONTEXT_LIMITS.maxGraphNodes },
    });

    const item = itemsOfType(snapshot, "graph")[0];
    for (const node of item.nodes) {
      expect(["a1", "a2", "a3", "a4", "a5"]).toContain(node.tabId);
    }
  });

  it("refuses a centre outside the scope", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["graph"],
      graph: { centerTabIds: ["b1"], depth: 2 },
    });
    expect(itemsOfType(snapshot, "graph")).toEqual([]);
    expect(omissionFor(snapshot, "graph", "out-of-scope")).toBeDefined();
  });
});

/** The same project request, resolved as a machine that may run agents locally. */
function resolveLocal(): AgentContextSnapshot {
  const result = resolveContext(
    { scope: scopeAWithProject(), sources: ["project"], projectIds: ["proj-a"] },
    fixtureWorld(),
    { ...OPTIONS, localRuntimeAllowed: true }
  );
  if (!result.ok) throw new Error(`expected resolution, got ${result.reason}`);
  return result.snapshot;
}

describe("project context", () => {
  it("resolves metadata, and the root only when the runtime is local", () => {
    const local = itemsOfType(resolveLocal(), "project");

    expect(local[0]).toMatchObject({
      sourceId: "proj-a",
      label: "API service",
      root: "C:/work/api",
      authorizedProviderCount: 1,
    });
  });

  it("withholds the root by default, which is what a hosted runtime gets", () => {
    const snapshot = resolve({
      scope: scopeAWithProject(),
      sources: ["project"],
      projectIds: ["proj-a"],
    });

    const [item] = itemsOfType(snapshot, "project");
    expect(item.root).toBeUndefined();
    expect(item.rootWithheld).toBe(true);
    expect(omissionFor(snapshot, "project", "hosted-runtime")).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain("C:/work/api");
  });

  it("never carries file contents or a directory listing", () => {
    const [item] = itemsOfType(resolveLocal(), "project");

    for (const forbidden of ["files", "contents", "tree", "entries", "readme", "git"]) {
      expect(Object.keys(item)).not.toContain(forbidden);
    }
  });

  it("refuses a project outside the scope", () => {
    const snapshot = resolve({
      scope: scopeAWithProject(),
      sources: ["project"],
      projectIds: ["proj-b"],
    });
    expect(itemsOfType(snapshot, "project")).toEqual([]);
    expect(omissionFor(snapshot, "project", "out-of-scope")).toBeDefined();
  });
});

describe("agent activity context", () => {
  it("resolves runs from in-scope workspaces only", () => {
    const snapshot = resolve({ scope: scopeA(), sources: ["agent_activity"] });

    expect(itemsOfType(snapshot, "agent_activity")).toEqual([
      {
        sourceType: "agent_activity",
        sourceId: "run-a",
        label: "Rework the deploy script",
        runId: "run-a",
        workspaceId: "ws-a",
        agentName: "Claude Code",
        provider: "claude-code",
        status: "completed",
        startedAt: T0 + 10_000,
        endedAt: T0 + 20_000,
        summary: "Finished",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("run-b");
  });

  it("carries no artifact, path or event payload", () => {
    const [item] = itemsOfType(
      resolve({ scope: scopeA(), sources: ["agent_activity"] }),
      "agent_activity"
    );

    // A WorkArtifact id embeds the absolute project root, so an artifact
    // reference here would smuggle a local path into context that the
    // project source deliberately withholds.
    for (const forbidden of ["artifacts", "artifactIds", "paths", "files", "events"]) {
      expect(Object.keys(item)).not.toContain(forbidden);
    }
  });

  it("bounds the number of runs", () => {
    const snapshot = resolve({
      scope: { ownerId: "user-1", workspaceIds: ["ws-a", "ws-b"], projectIds: [] },
      sources: ["agent_activity"],
      agentActivity: { limit: 1 },
    });

    const items = itemsOfType(snapshot, "agent_activity");
    expect(items).toHaveLength(1);
    // Newest first: run-b is later than run-a.
    expect(items[0].sourceId).toBe("run-b");
    expect(omissionFor(snapshot, "agent_activity", "limit-agent-activity")).toMatchObject({
      count: 1,
    });
  });
});

describe("limits", () => {
  it("caps tabs and reports exactly how many were dropped", () => {
    const snapshot = resolve(
      { scope: { ownerId: "user-1", workspaceIds: ["ws-big"], projectIds: [] }, sources: ["tab"], workspaceIds: ["ws-big"] },
      largeWorld(150)
    );

    expect(itemsOfType(snapshot, "tab")).toHaveLength(DEFAULT_CONTEXT_LIMITS.maxTabs);
    expect(omissionFor(snapshot, "tab", "limit-tabs")).toMatchObject({ count: 50 });
    expect(snapshot.truncated).toBe(true);
  });

  it("never silently truncates — every drop has an omission", () => {
    const snapshot = resolve(
      { scope: { ownerId: "user-1", workspaceIds: ["ws-big"], projectIds: [] }, sources: ["tab"], workspaceIds: ["ws-big"] },
      largeWorld(150)
    );

    const dropped = snapshot.omissions.reduce((sum, o) => sum + o.count, 0);
    expect(dropped).toBe(50);
  });

  it("enforces the character budget", () => {
    const snapshot = resolve(
      {
        scope: { ownerId: "user-1", workspaceIds: ["ws-big"], projectIds: [] },
        sources: ["tab"],
        workspaceIds: ["ws-big"],
        limits: { maxCharacters: 200 },
      },
      largeWorld(150)
    );

    expect(snapshot.characterCount).toBeLessThanOrEqual(200);
    expect(omissionFor(snapshot, "tab", "limit-characters")).toBeDefined();
  });

  it("clamps an over-large limit to the ceiling rather than honouring it", () => {
    const clamped = clampLimits({ maxTabs: 10_000 });
    expect(clamped.maxTabs).toBe(MAX_CONTEXT_LIMITS.maxTabs);
  });

  it("clamps nonsense to a real number", () => {
    const clamped = clampLimits({
      maxTabs: Number.NaN,
      maxGraphNodes: -5,
      // Infinity is not a large request, it is a broken one — so it falls
      // back to the conservative default rather than being read as "the
      // most you will allow".
      maxItems: Number.POSITIVE_INFINITY,
    });

    expect(clamped.maxTabs).toBe(DEFAULT_CONTEXT_LIMITS.maxTabs);
    expect(clamped.maxGraphNodes).toBe(0);
    expect(clamped.maxItems).toBe(DEFAULT_CONTEXT_LIMITS.maxItems);
  });

  it("records the limits it actually ran under", () => {
    const snapshot = resolve({
      scope: scopeA(),
      sources: ["tab"],
      workspaceIds: ["ws-a"],
      limits: { maxTabs: 2 },
    });
    expect(snapshot.limits.maxTabs).toBe(2);
  });
});

describe("snapshots", () => {
  it("stamps a capture time and an id", () => {
    const snapshot = resolve({ scope: scopeA(), sources: ["tab"], tabIds: ["a1"] });
    expect(snapshot.id).toBe("snap-1");
    expect(snapshot.capturedAt).toBe(T0 + 60_000);
  });

  it("is frozen all the way down", () => {
    const snapshot = resolve({ scope: scopeA(), sources: ["tab"], workspaceIds: ["ws-a"] });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
    expect(Object.isFrozen(snapshot.scope)).toBe(true);
    expect(Object.isFrozen(snapshot.scope.workspaceIds)).toBe(true);
  });

  it("does not change when the world changes underneath it", () => {
    const world = fixtureWorld();
    const snapshot = resolve(
      { scope: scopeA(), sources: ["tab"], workspaceIds: ["ws-a"] },
      world
    );
    const before = JSON.stringify(snapshot);

    // The user adds a tab after the snapshot was taken.
    const mutated = {
      ...world,
      workspaces: world.workspaces.map((w) =>
        w.id === "ws-a"
          ? {
              ...w,
              tabs: [
                ...w.tabs,
                {
                  id: "a6",
                  url: "https://new.example.com/",
                  normalizedUrl: "https://new.example.com/",
                  domain: "new.example.com",
                  title: "Added later",
                },
              ],
            }
          : w
      ),
    };

    expect(JSON.stringify(snapshot)).toBe(before);
    const later = resolve({ scope: scopeA(), sources: ["tab"], workspaceIds: ["ws-a"] }, mutated);
    expect(later.items).toHaveLength(6);
  });

  it("leaves the world untouched", () => {
    const world = fixtureWorld();
    const before = JSON.stringify(world);
    resolve(
      {
        scope: scopeAWithProject(),
        sources: ["workspace", "tab", "collection", "relationship", "graph", "project", "agent_activity"],
        workspaceIds: ["ws-a"],
        collectionIds: ["col-a1"],
        projectIds: ["proj-a"],
        graph: { centerTabIds: ["a1"], depth: 2 },
      },
      world
    );
    expect(JSON.stringify(world)).toBe(before);
  });

  it("is reproducible", () => {
    const request: AgentContextRequest = {
      scope: scopeA(),
      sources: ["tab", "relationship"],
      workspaceIds: ["ws-a"],
    };
    const a = resolve(request);
    const b = resolve(request);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
