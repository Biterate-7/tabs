import { describe, expect, it } from "vitest";
import { INSIGHT_LIMITS, duplicateTabGroups, searchWorkspaceTabs, summarizeWorkspace } from "./insight";
import { readSessionContextSnapshot } from "./snapshot";

/**
 * The workspace as a whole, bounded (Phase J.5): a summary that helps an
 * agent decide what to read next, TabDump's own duplicate detection, and a
 * search that matches only what an agent may see.
 */

function tab(id: string, url: string, title?: string, extra: Record<string, unknown> = {}) {
  return { id, url, normalizedUrl: url, domain: new URL(url).hostname, ...(title ? { title } : {}), ...extra };
}

const TABS = [
  tab("t1", "https://mit.edu/admissions", "MIT admissions", { pinned: true }),
  tab("t2", "https://mit.edu/admissions", "MIT admissions (again)"),
  tab("t3", "http://www.stanford.edu/essays", "Stanford essays"),
  tab("t4", "https://stanford.edu/essays", "Stanford essay prompts", { notes: "deadline in november" }),
  tab("t5", "https://files.example.com/report?access_token=SECRET123", "Quarterly report"),
  tab("t6", "https://arxiv.org/abs/1234", "Quantum physics research", { isFavorite: true }),
];

function data(tabs = TABS, collections = [{ id: "c1", workspaceId: "ws", name: "Colleges", tabIds: ["t1", "t3"], createdAt: 1, updatedAt: 1 }]) {
  return readSessionContextSnapshot(
    {
      workspace: { id: "ws", name: "Launch Plan", createdAt: 1, updatedAt: 2, tabs },
      collections,
      dependencies: [{ id: "d1", parentTabId: "t1", childTabId: "t2", createdAt: 1 }],
    },
    "ws"
  )!;
}

describe("summarizeWorkspace", () => {
  it("gives the shape — counts, collections by size, top sites, duplicates — and no tab", () => {
    const summary = summarizeWorkspace(data());
    expect(summary).toMatchObject({
      workspace: { workspaceId: "ws", name: "Launch Plan" },
      tabs: { total: 6, uncategorized: 4, pinned: 1, favorites: 1, withNotes: 1 },
      collections: { total: 1, empty: 0, list: [{ collectionId: "c1", name: "Colleges", tabCount: 2 }], more: 0 },
      relationships: { total: 1 },
      duplicates: { groups: 2, tabs: 4 },
    });
    expect(summary.domains.top[0]).toEqual({ domain: "mit.edu", tabs: 2 });
    const text = JSON.stringify(summary);
    expect(text).not.toContain("MIT admissions");
    expect(text).not.toContain("SECRET123");
  });

  it("stays bounded however large the workspace is", () => {
    const tabs = Array.from({ length: 800 }, (_, index) => tab(`t${index}`, `https://site${index % 90}.example/${index}`, `Tab ${index}`));
    const collections = Array.from({ length: 60 }, (_, index) => ({
      id: `c${index}`,
      workspaceId: "ws",
      name: `Collection ${index}`,
      tabIds: [`t${index}`],
      createdAt: 1,
      updatedAt: 1,
    }));
    const summary = summarizeWorkspace(data(tabs, collections));
    expect(summary.collections.list).toHaveLength(INSIGHT_LIMITS.summaryCollections);
    expect(summary.collections.more).toBe(60 - INSIGHT_LIMITS.summaryCollections);
    expect(summary.domains.top).toHaveLength(INSIGHT_LIMITS.summaryDomains);
    expect(JSON.stringify(summary).length).toBeLessThan(6_000);
  });
});

describe("duplicateTabGroups", () => {
  it("exposes TabDump's own detection: exact copies first, then likely ones — redacted, with where each tab is", () => {
    const found = duplicateTabGroups(data());
    expect(found.totalGroups).toBe(2);
    expect(found.groups[0]).toMatchObject({ confidence: "high", tabs: [{ tabId: "t1", collection: { name: "Colleges" } }, { tabId: "t2" }] });
    expect(found.groups[0].tabs[1].collection).toBeUndefined();
    expect(found.groups[1]).toMatchObject({ confidence: "medium", tabs: [{ tabId: "t3" }, { tabId: "t4" }] });
  });

  it("never returns a secret query value", () => {
    const copies = [
      tab("a", "https://files.example.com/r?access_token=SECRET123", "Report"),
      tab("b", "https://files.example.com/r?access_token=SECRET123", "Report"),
    ];
    expect(JSON.stringify(duplicateTabGroups(data(copies, [])))).not.toContain("SECRET123");
  });
});

describe("searchWorkspaceTabs", () => {
  it("matches every word, title first, keeping the workspace's order on ties", () => {
    const found = searchWorkspaceTabs(data(), "stanford");
    expect(found.matches.map((match) => match.tabId)).toEqual(["t3", "t4"]);
    expect(found.matches[0].matchedOn).toContain("title");
    expect(searchWorkspaceTabs(data(), "stanford prompts").matches.map((match) => match.tabId)).toEqual(["t4"]);
    expect(searchWorkspaceTabs(data(), "arxiv").matches.map((match) => match.tabId)).toEqual(["t6"]);
  });

  it("cannot be used to probe a redacted secret", () => {
    expect(searchWorkspaceTabs(data(), "SECRET123").total).toBe(0);
    expect(searchWorkspaceTabs(data(), "report").total).toBe(1);
  });

  it("searches notes only when asked, and only tabs in no collection when asked", () => {
    expect(searchWorkspaceTabs(data(), "november").total).toBe(0);
    expect(searchWorkspaceTabs(data(), "november", { includeNotes: true }).matches).toEqual([
      { tabId: "t4", score: 1, matchedOn: ["notes"] },
    ]);
    expect(searchWorkspaceTabs(data(), "admissions", { uncategorizedOnly: true }).matches.map((match) => match.tabId)).toEqual(["t2"]);
  });

  it("is bounded", () => {
    const tabs = Array.from({ length: 200 }, (_, index) => tab(`t${index}`, `https://example.com/${index}`, `Match ${index}`));
    const found = searchWorkspaceTabs(data(tabs, []), "match", { limit: 1000 });
    expect(found.total).toBe(200);
    expect(found.matches).toHaveLength(INSIGHT_LIMITS.searchResults);
  });
});
