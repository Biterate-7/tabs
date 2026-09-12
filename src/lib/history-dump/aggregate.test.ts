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

  it("merges www/protocol/fragment variants of the same page into one entry", () => {
    const result = aggregateHistoryEntries([
      item({ url: "https://www.example.com/article", visitCount: 1 }),
      item({ url: "http://example.com/article/", visitCount: 1 }),
      item({ url: "https://example.com/article#notes", visitCount: 1 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].visitCount).toBe(3);
  });

  it("merges one video watched at different timestamps, and keeps a different video apart", () => {
    const result = aggregateHistoryEntries([
      item({ url: "https://www.youtube.com/watch?v=AAA&t=30", visitCount: 1 }),
      item({ url: "https://youtu.be/AAA", visitCount: 1 }),
      item({ url: "https://www.youtube.com/watch?v=BBB", visitCount: 1 }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((e) => e.resourceKey === "youtube.com/video/AAA")?.visitCount).toBe(2);
    expect(result.find((e) => e.resourceKey === "youtube.com/video/BBB")?.visitCount).toBe(1);
  });

  it("reports the most recently visited variant as the entry's own url", () => {
    const result = aggregateHistoryEntries([
      item({ url: "https://example.com/article?utm_source=x", lastVisitTime: 1000 }),
      item({ url: "https://www.example.com/article", lastVisitTime: 5000 }),
    ]);
    expect(result[0].url).toBe("https://www.example.com/article");
    expect(result[0].normalizedUrl).toBe("https://www.example.com/article");
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

/**
 * History rows come from chrome.history via the extension bridge, so they are
 * untrusted the same way an extension batch is — and a real profile genuinely
 * does contain file:// and chrome:// entries. aggregateHistoryEntries runs
 * every row through parseSingleUrl, which is what keeps History Dump from
 * being a way back in for a scheme the parser and opener both refuse.
 */
describe("History Dump cannot reintroduce an unsafe URL", () => {
  const UNSAFE = [
    "javascript:alert(1)",
    "javascript://example.com/%0aalert(1)",
    "data://example.com/x",
    "file:///C:/Users/me/secrets.txt",
    "file://example.com/share",
    "vbscript://example.com/x",
    "about:blank",
    "chrome://settings",
    "chrome-extension://abcdefghijklmnop/page.html",
  ];

  it.each(UNSAFE)("drops a history row for %s", (url) => {
    expect(aggregateHistoryEntries([item({ url })])).toEqual([]);
  });

  it("keeps ordinary http(s) history rows, underscores intact", () => {
    const result = aggregateHistoryEntries([
      item({ url: "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events" }),
      item({ url: "file:///etc/passwd", historyItemId: "2" }),
    ]);
    expect(result.map((r) => r.url)).toEqual([
      "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events",
    ]);
  });
})
