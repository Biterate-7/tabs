import { describe, expect, it } from "vitest";
import { analyzeForOrganization } from "./analyze";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

function tab(id: string, title: string, domain = "example.com"): Tab {
  return { id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, title };
}

function workspace(over: Partial<Workspace> & { id: string; name: string; tabs: Tab[] }): Workspace {
  return { createdAt: 0, updatedAt: 0, ...over };
}

describe("analyzeForOrganization", () => {
  it("reports a friendly tiny-library message and proposes nothing for a handful of tabs", () => {
    const inbox = workspace({ id: "ws-1", name: "Inbox", tabs: [tab("t1", "One"), tab("t2", "Two"), tab("t3", "Three")] });
    const plan = analyzeForOrganization([inbox], [inbox]);

    expect(plan.workspaces).toEqual([]);
    expect(plan.uncertainTabs).toEqual([]);
    expect(plan.noopReason).toContain("You only have 3 tabs");
  });

  it("creates a new workspace proposal for a coherent cluster of unplaced tabs", () => {
    const inbox = workspace({
      id: "ws-1",
      name: "Inbox",
      tabs: [
        tab("t1", "Physics IA Notes", "docs.google.com"),
        tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
        tab("t3", "Physics Lab Report", "notion.so"),
        tab("t4", "Unrelated recipe", "cooking.example"),
        tab("t5", "Grocery list", "shopping.example"),
      ],
    });

    const plan = analyzeForOrganization([inbox], [inbox]);

    expect(plan.workspaces).toHaveLength(1);
    expect(plan.workspaces[0].proposedName).toBe("Physics");
    expect(plan.workspaces[0].existingWorkspaceId).toBeUndefined();
    expect(new Set(plan.workspaces[0].tabs.map((t) => t.tabId))).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("reuses an existing workspace instead of proposing a duplicate-named new one", () => {
    const physics = workspace({ id: "ws-physics", name: "Physics", tabs: [tab("existing", "Physics syllabus")] });
    const inbox = workspace({
      id: "ws-inbox",
      name: "Inbox",
      tabs: [
        tab("t1", "Physics IA Notes", "docs.google.com"),
        tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
        tab("t3", "Physics Lab Report", "notion.so"),
        tab("f1", "Grocery list", "shopping.example"),
        tab("f2", "Recipe idea", "cooking.example"),
      ],
    });

    const plan = analyzeForOrganization([inbox], [physics, inbox]);

    expect(plan.workspaces).toHaveLength(1);
    expect(plan.workspaces[0].existingWorkspaceId).toBe("ws-physics");
    expect(plan.workspaces[0].proposedName).toBe("Physics");
  });

  it("does not propose anything for a cluster whose tabs already all live in the matching workspace", () => {
    const physics = workspace({
      id: "ws-physics",
      name: "Physics",
      tabs: [tab("t1", "Physics IA Notes"), tab("t2", "Physics Orbital Mechanics"), tab("t3", "Physics Lab Report")],
    });

    const plan = analyzeForOrganization([physics], [physics]);
    expect(plan.workspaces).toEqual([]);
    expect(plan.noopReason).toBeTruthy();
  });

  it("groups differently-worded tabs via a semantic cluster hint (AGENTS.md's General Relativity / Schwarzschild / S2 orbit example)", () => {
    const inbox = workspace({
      id: "ws-1",
      name: "Inbox",
      tabs: [
        tab("t1", "General Relativity Notes", "arxiv.org"),
        tab("t2", "Schwarzschild Metric", "wikipedia.org"),
        tab("t3", "S2 Star Orbit Data", "nasa.gov"),
        tab("t4", "Grocery list", "shopping.example"),
        tab("t5", "Recipe idea", "cooking.example"),
      ],
    });

    const withoutHints = analyzeForOrganization([inbox], [inbox]);
    expect(withoutHints.workspaces).toEqual([]);

    const withHints = analyzeForOrganization(
      [inbox],
      [inbox],
      [
        { tabId: "t1", clusterKey: "sem-0" },
        { tabId: "t2", clusterKey: "sem-0" },
        { tabId: "t3", clusterKey: "sem-0" },
      ]
    );
    expect(withHints.workspaces).toHaveLength(1);
    expect(new Set(withHints.workspaces[0].tabs.map((t) => t.tabId))).toEqual(new Set(["t1", "t2", "t3"]));
    expect(withHints.workspaces[0].tabs.every((t) => t.confidence === "high")).toBe(true);
  });

  it("does not fragment a large library into one workspace per tiny cluster", () => {
    const tabs = Array.from({ length: 12 }, (_, i) => tab(`t${i}`, `Physics topic ${i}`, "physicsforum.example"));
    const inbox = workspace({ id: "ws-1", name: "Inbox", tabs });

    const plan = analyzeForOrganization([inbox], [inbox]);
    expect(plan.workspaces.length).toBeLessThanOrEqual(2);
  });

  it("folds a small (below minimum) cluster into Miscellaneous rather than uncertain, when there are enough leftovers", () => {
    const inbox = workspace({
      id: "ws-1",
      name: "Inbox",
      tabs: [
        tab("t1", "Physics IA Notes", "docs.google.com"),
        tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
        tab("t3", "Physics Lab Report", "notion.so"),
        tab("m1", "Bicycle repair guide", "bikes.example"),
        tab("m2", "Bicycle chain maintenance", "bikeforum.example"),
      ],
    });

    const plan = analyzeForOrganization([inbox], [inbox]);
    const misc = plan.workspaces.find((w) => w.proposedName === "Miscellaneous");
    expect(misc).toBeTruthy();
    expect(new Set(misc!.tabs.map((t) => t.tabId))).toEqual(new Set(["m1", "m2"]));
  });

  it("flags a single unrelated leftover tab as uncertain with quick-decision suggestions", () => {
    const inbox = workspace({
      id: "ws-1",
      name: "Inbox",
      tabs: [
        tab("t1", "Physics IA Notes", "physicsdocs.org"),
        tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
        tab("t3", "Physics Lab Report", "notion.so"),
        tab("f1", "Recipe idea", "cooking.example"),
        tab("g1", "a - Google Search", "google.com"),
      ],
    });

    const plan = analyzeForOrganization([inbox], [inbox]);
    const googleTab = plan.uncertainTabs.find((u) => u.tabId === "g1");
    expect(googleTab).toBeTruthy();
    expect(googleTab!.suggestions.length).toBeGreaterThan(0);
    expect(googleTab!.suggestions.some((s) => s.name.startsWith("Keep in"))).toBe(true);
    // The Google Search tab never joins the Physics cluster just because it happens to share a generic domain-derived word.
    expect(plan.workspaces.find((w) => w.proposedName === "Physics")?.tabs.some((t) => t.tabId === "g1")).toBeFalsy();
  });

  it("detects duplicate tabs by normalized URL without removing anything", () => {
    const dupUrl = "https://example.com/same-page";
    const inbox = workspace({
      id: "ws-1",
      name: "Inbox",
      tabs: [
        { id: "d1", url: dupUrl, normalizedUrl: dupUrl, domain: "example.com", title: "Page" },
        { id: "d2", url: dupUrl, normalizedUrl: dupUrl, domain: "example.com", title: "Page" },
        tab("t1", "Physics IA Notes", "docs.google.com"),
        tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
        tab("t3", "Physics Lab Report", "notion.so"),
      ],
    });

    const plan = analyzeForOrganization([inbox], [inbox]);
    expect(plan.duplicates).toHaveLength(1);
    expect(new Set(plan.duplicates[0].tabIds)).toEqual(new Set(["d1", "d2"]));
    // Duplicates are reported, never silently removed from the actionable plan.
    expect(plan.totalTabsConsidered).toBe(5);
  });

  it("reports no useful organization when the library is already well-placed", () => {
    const physics = workspace({
      id: "ws-physics",
      name: "Physics",
      tabs: [
        tab("t1", "Physics IA Notes", "docs.google.com"),
        tab("t2", "Physics Orbital Mechanics", "wikipedia.org"),
        tab("t3", "Physics Lab Report", "notion.so"),
      ],
    });
    const mun = workspace({
      id: "ws-mun",
      name: "MUN",
      tabs: [
        tab("t4", "MUN Resolution Draft", "un.org"),
        tab("t5", "MUN Position Paper", "bestdelegate.example"),
        tab("t6", "MUN Rules of Procedure", "unausa.example"),
      ],
    });

    const plan = analyzeForOrganization([physics, mun], [physics, mun]);
    expect(plan.workspaces).toEqual([]);
    expect(plan.uncertainTabs).toEqual([]);
    expect(plan.noopReason).toBe("I couldn't find a useful organization that would improve your current setup.");
  });

  it("proposes sub-groups for a large cluster that splits cleanly by domain", () => {
    const tabs = [
      ...Array.from({ length: 4 }, (_, i) => tab(`gh${i}`, `Development repo ${i}`, "github.com")),
      ...Array.from({ length: 4 }, (_, i) => tab(`so${i}`, `Development question ${i}`, "stackoverflow.com")),
    ];
    const inbox = workspace({ id: "ws-1", name: "Inbox", tabs });
    // Force all 8 into one cluster via a semantic hint, simulating "these
    // are all part of one Development effort even though they're split
    // across two tools" — domain-based clustering alone would otherwise
    // split github.com/stackoverflow.com into two separate clusters before
    // group sub-splitting ever gets a chance to run.
    const semanticHints = tabs.map((t) => ({ tabId: t.id, clusterKey: "sem-dev" }));

    const plan = analyzeForOrganization([inbox], [inbox], semanticHints);
    expect(plan.workspaces).toHaveLength(1);
    expect(plan.workspaces[0].groups?.length).toBe(2);
    const groupNames = plan.workspaces[0].groups!.map((g) => g.proposedName).sort();
    expect(groupNames).toEqual(["Github", "Stackoverflow"]);
  });
});
