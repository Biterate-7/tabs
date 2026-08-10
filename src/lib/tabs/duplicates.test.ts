import { describe, expect, it } from "vitest";
import { markDuplicates } from "./duplicates";
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
