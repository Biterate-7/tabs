import { describe, expect, it } from "vitest";
import {
  findDuplicateGroups,
  computeCleanupSummary,
  defaultSelection,
  removalIds,
  removeTabs,
} from "./cleanup";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com/page",
    normalizedUrl: "https://example.com/page",
    domain: "example.com",
    category: "other",
    confidence: 1,
    ...over,
  };
}

describe("findDuplicateGroups", () => {
  it("returns no groups when every tab is unique", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://b.com" }),
    ];
    expect(findDuplicateGroups(tabs)).toEqual([]);
  });

  it("groups exact duplicates and counts copies", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com/x" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com/x" }),
      makeTab({ id: "3", normalizedUrl: "https://a.com/x" }),
    ];
    const groups = findDuplicateGroups(tabs);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].tabs.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("groups tracking-parameter duplicates together (same normalizedUrl, different original url)", () => {
    const tabs = [
      makeTab({
        id: "1",
        url: "https://a.com/x?utm_source=news",
        normalizedUrl: "https://a.com/x",
      }),
      makeTab({ id: "2", url: "https://a.com/x", normalizedUrl: "https://a.com/x" }),
    ];
    const groups = findDuplicateGroups(tabs);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].tabs[0].url).toBe("https://a.com/x?utm_source=news");
  });

  it("exposes domain and a title falling back to domain", () => {
    const tabs = [
      makeTab({ id: "1", domain: "a.com", normalizedUrl: "https://a.com/x" }),
      makeTab({
        id: "2",
        domain: "a.com",
        normalizedUrl: "https://a.com/x",
        title: "Real Title",
      }),
    ];
    const [group] = findDuplicateGroups(tabs);
    expect(group.domain).toBe("a.com");
    expect(group.title).toBe("Real Title");
  });

  it("returns multiple independent groups", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com" }),
      makeTab({ id: "3", normalizedUrl: "https://b.com" }),
      makeTab({ id: "4", normalizedUrl: "https://b.com" }),
      makeTab({ id: "5", normalizedUrl: "https://c.com" }),
    ];
    expect(findDuplicateGroups(tabs)).toHaveLength(2);
  });

  it("handles an empty workspace", () => {
    expect(findDuplicateGroups([])).toEqual([]);
  });
});

describe("computeCleanupSummary", () => {
  it("reports total, unique, duplicates, needsReview and groupCount", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com", isDuplicate: true }),
      makeTab({ id: "3", normalizedUrl: "https://b.com", confidence: 0.1 }),
    ];
    expect(computeCleanupSummary(tabs)).toEqual({
      total: 3,
      unique: 2,
      duplicates: 1,
      needsReview: 1,
      groupCount: 1,
    });
  });

  it("counts a tab with no confidence as needing review", () => {
    const tabs = [makeTab({ id: "1", confidence: undefined })];
    expect(computeCleanupSummary(tabs).needsReview).toBe(1);
  });

  it("handles an empty workspace", () => {
    expect(computeCleanupSummary([])).toEqual({
      total: 0,
      unique: 0,
      duplicates: 0,
      needsReview: 0,
      groupCount: 0,
    });
  });
});

describe("defaultSelection / removalIds", () => {
  const tabs = [
    makeTab({ id: "1", normalizedUrl: "https://a.com" }),
    makeTab({ id: "2", normalizedUrl: "https://a.com" }),
    makeTab({ id: "3", normalizedUrl: "https://a.com" }),
    makeTab({ id: "4", normalizedUrl: "https://b.com" }),
    makeTab({ id: "5", normalizedUrl: "https://b.com" }),
  ];

  it("defaults to keeping the first copy of every group", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = defaultSelection(groups);
    expect(selection.keepIds["https://a.com"]).toBe("1");
    expect(selection.keepIds["https://b.com"]).toBe("4");
    expect(selection.skippedKeys).toEqual([]);
  });

  it("removes every copy except the kept one", () => {
    const groups = findDuplicateGroups(tabs);
    expect(removalIds(groups, defaultSelection(groups)).sort()).toEqual([
      "2",
      "3",
      "5",
    ]);
  });

  it("respects a different kept copy", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = defaultSelection(groups);
    selection.keepIds["https://a.com"] = "3";
    expect(removalIds(groups, selection).sort()).toEqual(["1", "2", "5"]);
  });

  it("removes nothing from a skipped group", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = {
      ...defaultSelection(groups),
      skippedKeys: ["https://a.com"],
    };
    expect(removalIds(groups, selection)).toEqual(["5"]);
  });

  it("removes nothing when every group is skipped", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = {
      ...defaultSelection(groups),
      skippedKeys: ["https://a.com", "https://b.com"],
    };
    expect(removalIds(groups, selection)).toEqual([]);
  });
});

describe("removeTabs", () => {
  it("removes the given ids and leaves the rest in order", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com" }),
      makeTab({ id: "3", normalizedUrl: "https://b.com" }),
    ];
    expect(removeTabs(tabs, ["2"]).map((t) => t.id)).toEqual(["1", "3"]);
  });

  it("re-marks duplicates so survivors are no longer flagged", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com", isDuplicate: true }),
    ];
    const result = removeTabs(tabs, ["2"]);
    expect(result).toHaveLength(1);
    expect(result[0].isDuplicate).toBe(false);
  });

  it("is a no-op for an empty id list", () => {
    const tabs = [makeTab({ id: "1" })];
    expect(removeTabs(tabs, [])).toHaveLength(1);
  });
});
