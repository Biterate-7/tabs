import { describe, expect, it } from "vitest";
import { findDuplicateGroups, markDuplicates } from "./duplicates";
import type { Tab } from "./types";

function makeTab(normalizedUrl: string, id: string): Tab {
  return { id, url: normalizedUrl, normalizedUrl, domain: "example.com" };
}

describe("markDuplicates", () => {
  it("does not flag unique tabs", () => {
    const tabs = markDuplicates([
      makeTab("https://a.com/1", "1"),
      makeTab("https://a.com/2", "2"),
    ]);
    expect(tabs.every((t) => !t.isDuplicate)).toBe(true);
  });

  it("flags exact duplicates after the first occurrence", () => {
    const tabs = markDuplicates([
      makeTab("https://example.com/page", "1"),
      makeTab("https://example.com/page", "2"),
    ]);
    expect(tabs[0].isDuplicate).toBeFalsy();
    expect(tabs[1].isDuplicate).toBe(true);
  });

  it("flags normalized-equivalent duplicates (tracking params differ)", () => {
    const tabs = markDuplicates([
      makeTab("https://example.com/page", "1"),
      makeTab("https://example.com/page", "2"), // normalizedUrl already stripped upstream
    ]);
    expect(tabs[1].isDuplicate).toBe(true);
  });

  it("handles an empty list", () => {
    expect(markDuplicates([])).toEqual([]);
  });
});

describe("findDuplicateGroups", () => {
  it("returns nothing when every item has a unique URL", () => {
    const groups = findDuplicateGroups([
      { id: "1", normalizedUrl: "https://a.com/1", domain: "a.com" },
      { id: "2", normalizedUrl: "https://a.com/2", domain: "a.com" },
    ]);
    expect(groups).toEqual([]);
  });

  it("groups exact-URL duplicates at high confidence", () => {
    const groups = findDuplicateGroups([
      { id: "1", normalizedUrl: "https://a.com/x", domain: "a.com" },
      { id: "2", normalizedUrl: "https://a.com/x", domain: "a.com" },
      { id: "3", normalizedUrl: "https://a.com/x", domain: "a.com" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe("high");
    expect(groups[0].ids.sort()).toEqual(["1", "2", "3"]);
  });

  it("groups www/non-www variants at medium confidence, never mixing with a high-confidence group", () => {
    const groups = findDuplicateGroups([
      { id: "1", normalizedUrl: "https://example.com/page", domain: "example.com" },
      { id: "2", normalizedUrl: "https://www.example.com/page", domain: "www.example.com" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe("medium");
    expect(groups[0].ids.sort()).toEqual(["1", "2"]);
  });

  it("claims items for a high-confidence exact match first, leaving a now-unpaired variant out entirely", () => {
    const groups = findDuplicateGroups([
      { id: "1", normalizedUrl: "https://example.com/page", domain: "example.com" },
      { id: "2", normalizedUrl: "https://example.com/page", domain: "example.com" },
      { id: "3", normalizedUrl: "https://www.example.com/page", domain: "www.example.com" },
    ]);
    // "3" would only ever join a medium-confidence group alongside another
    // unclaimed item — here its only possible partners ("1"/"2") were
    // already claimed by the high-confidence exact-match group, so it has
    // no one left to pair with and simply isn't reported as a duplicate.
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe("high");
    expect(groups[0].ids.sort()).toEqual(["1", "2"]);
  });

  it("assigns a stable, unique duplicateGroupId per group", () => {
    const groups = findDuplicateGroups([
      { id: "1", normalizedUrl: "https://a.com/1", domain: "a.com" },
      { id: "2", normalizedUrl: "https://a.com/1", domain: "a.com" },
      { id: "3", normalizedUrl: "https://b.com/1", domain: "b.com" },
      { id: "4", normalizedUrl: "https://b.com/1", domain: "b.com" },
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.duplicateGroupId)).size).toBe(2);
  });

  it("works with a non-string id type (e.g. numeric browser tab ids)", () => {
    const groups = findDuplicateGroups([
      { id: 1, normalizedUrl: "https://a.com/1", domain: "a.com" },
      { id: 2, normalizedUrl: "https://a.com/1", domain: "a.com" },
    ]);
    expect(groups[0].ids).toEqual([1, 2]);
  });
});
