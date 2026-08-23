import { describe, expect, it } from "vitest";
import { findBestWorkspaceMatch, scoreWorkspaceMatch } from "./match";
import type { ScopedTab } from "./types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

function makeTab(id: string, title: string, domain = "example.com"): Tab {
  return { id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, title };
}

function makeWorkspace(over: Partial<Workspace> & { id: string; name: string }): Workspace {
  return { tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

describe("findBestWorkspaceMatch", () => {
  it("reuses an existing workspace whose name matches the cluster's keywords", () => {
    const clusterTabIds = ["t1", "t2"];
    const clusterTabsById = new Map<string, ScopedTab>([
      ["t1", { tab: makeTab("t1", "Physics IA Notes"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
      ["t2", { tab: makeTab("t2", "Physics Orbital Mechanics"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
    ]);
    const physics = makeWorkspace({ id: "ws-physics", name: "Physics" });
    const mun = makeWorkspace({ id: "ws-mun", name: "MUN" });

    const match = findBestWorkspaceMatch(clusterTabIds, clusterTabsById, [physics, mun]);
    expect(match?.workspaceId).toBe("ws-physics");
  });

  it("reuses an existing workspace when the cluster's tabs are mostly (but not entirely) already in it", () => {
    // Scattered across two source workspaces, with most already in
    // ws-research — genuine partial-membership evidence. A cluster that's
    // ENTIRELY in one source workspace is a different, deliberately
    // excluded case — see scoreWorkspaceMatch's doc comment.
    const clusterTabIds = ["t1", "t2", "t3"];
    const clusterTabsById = new Map<string, ScopedTab>([
      ["t1", { tab: makeTab("t1", "Something"), workspaceId: "ws-research", workspaceName: "Research" }],
      ["t2", { tab: makeTab("t2", "Something else"), workspaceId: "ws-research", workspaceName: "Research" }],
      ["t3", { tab: makeTab("t3", "Another thing"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
    ]);
    const research = makeWorkspace({ id: "ws-research", name: "Research" });
    const inbox = makeWorkspace({ id: "ws-inbox", name: "Inbox" });

    const match = findBestWorkspaceMatch(clusterTabIds, clusterTabsById, [research, inbox]);
    expect(match?.workspaceId).toBe("ws-research");
  });

  it("never lets a cluster trivially match the single source workspace it entirely came from", () => {
    const clusterTabIds = ["t1", "t2", "t3"];
    const clusterTabsById = new Map<string, ScopedTab>([
      ["t1", { tab: makeTab("t1", "Something"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
      ["t2", { tab: makeTab("t2", "Something else"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
      ["t3", { tab: makeTab("t3", "Another thing"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
    ]);
    const inbox = makeWorkspace({ id: "ws-inbox", name: "Inbox" });

    expect(findBestWorkspaceMatch(clusterTabIds, clusterTabsById, [inbox])).toBeNull();
  });

  it("returns null when no existing workspace clears the reuse threshold", () => {
    const clusterTabIds = ["t1"];
    const clusterTabsById = new Map<string, ScopedTab>([
      ["t1", { tab: makeTab("t1", "Completely unrelated topic"), workspaceId: "ws-inbox", workspaceName: "Inbox" }],
    ]);
    const unrelated = makeWorkspace({ id: "ws-unrelated", name: "Cooking" });

    expect(findBestWorkspaceMatch(clusterTabIds, clusterTabsById, [unrelated])).toBeNull();
  });

  it("scores membership fraction, name overlap, and content overlap additively", () => {
    const clusterTabIds = ["t1"];
    const clusterTabsById = new Map<string, ScopedTab>([
      ["t1", { tab: makeTab("t1", "Physics notes"), workspaceId: "ws-physics", workspaceName: "Physics" }],
    ]);
    const physics = makeWorkspace({ id: "ws-physics", name: "Physics" });
    const score = scoreWorkspaceMatch(clusterTabIds, clusterTabsById, physics);
    expect(score).toBeGreaterThan(0);
  });
});
