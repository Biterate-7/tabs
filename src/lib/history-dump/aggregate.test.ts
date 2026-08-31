import { describe, expect, it } from "vitest";
import { aggregateHistoryEntries } from "./aggregate";
import type { HistoryVisitItem } from "@/lib/browser/protocol";

function item(over: Partial<HistoryVisitItem>): HistoryVisitItem {
  return { url: "https://example.com/article", title: "Article", lastVisitTime: 1000, visitCount: 1, historyItemId: "1", ...over };
}

describe("aggregateHistoryEntries", () => {
  it("merges exact duplicate urls, summing visit counts and keeping the latest visit time", () => {
    const result = aggregateHistoryEntries([
      item({ lastVisitTime: 1000, visitCount: 2 }),
      item({ lastVisitTime: 5000, visitCount: 3 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].visitCount).toBe(5);
    expect(result[0].lastVisitedAt).toBe(5000);
  });

  it("merges tracking-parameter variants of the same page into one entry", () => {
    const result = aggregateHistoryEntries([
      item({ url: "https://example.com/article?utm_source=x", visitCount: 1 }),
      item({ url: "https://example.com/article?utm_source=y", visitCount: 1 }),
      item({ url: "https://example.com/article", visitCount: 1 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].visitCount).toBe(3);
    expect(result[0].normalizedUrl).toBe("https://example.com/article");
  });

  it("keeps distinct pages as separate entries", () => {
    const result = aggregateHistoryEntries([
      item({ url: "https://example.com/a" }),
      item({ url: "https://example.com/b" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("prefers a longer, non-empty title when merging variants", () => {
    const result = aggregateHistoryEntries([
      item({ title: "" }),
      item({ title: "A Much More Descriptive Title" }),
    ]);
    expect(result[0].title).toBe("A Much More Descriptive Title");
  });

  it("counts distinct calendar days across merged variants", () => {
    const day1 = new Date(2026, 0, 1, 10).getTime();
    const day2 = new Date(2026, 0, 2, 10).getTime();
    const result = aggregateHistoryEntries([
      item({ url: "https://example.com/a?utm_source=x", lastVisitTime: day1 }),
      item({ url: "https://example.com/a?utm_source=y", lastVisitTime: day2 }),
    ]);
    expect(result[0].distinctDayCount).toBe(2);
  });

  it("drops entries whose url fails to parse", () => {
    const result = aggregateHistoryEntries([item({ url: "not a url" })]);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array for no input", () => {
    expect(aggregateHistoryEntries([])).toEqual([]);
  });
});
