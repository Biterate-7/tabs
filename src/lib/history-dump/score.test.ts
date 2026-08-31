import { describe, expect, it } from "vitest";
import { scoreHistoryEntry, describeHistoryEntry, candidateLabel, SUGGESTED_SCORE_THRESHOLD } from "./score";
import type { AggregatedHistoryEntry } from "./aggregate";

const NOW = new Date(2026, 0, 31).getTime();

function entry(over: Partial<AggregatedHistoryEntry>): AggregatedHistoryEntry {
  return {
    url: "https://example.com/article",
    normalizedUrl: "https://example.com/article",
    domain: "example.com",
    title: "A Meaningful Article Title",
    visitCount: 1,
    lastVisitedAt: NOW,
    distinctDayCount: 1,
    ...over,
  };
}

describe("scoreHistoryEntry", () => {
  it("is deterministic for the same input", () => {
    const e = entry({});
    expect(scoreHistoryEntry(e, NOW)).toBe(scoreHistoryEntry(e, NOW));
  });

  it("scores a more recent page higher than an older one, all else equal", () => {
    const recent = scoreHistoryEntry(entry({ lastVisitedAt: NOW }), NOW);
    const old = scoreHistoryEntry(entry({ lastVisitedAt: NOW - 15 * 24 * 60 * 60 * 1000 }), NOW);
    expect(recent).toBeGreaterThan(old);
  });

  it("scores a frequently visited page higher than a rarely visited one", () => {
    const frequent = scoreHistoryEntry(entry({ visitCount: 8 }), NOW);
    const rare = scoreHistoryEntry(entry({ visitCount: 1 }), NOW);
    expect(frequent).toBeGreaterThan(rare);
  });

  it("gives a small bonus for a meaningful title over a blank one", () => {
    const withTitle = scoreHistoryEntry(entry({ title: "A Meaningful Article Title" }), NOW);
    const withoutTitle = scoreHistoryEntry(entry({ title: undefined }), NOW);
    expect(withTitle).toBeGreaterThan(withoutTitle);
  });

  it("stays within 0-100", () => {
    const maxed = scoreHistoryEntry(entry({ visitCount: 999, distinctDayCount: 30, lastVisitedAt: NOW }), NOW);
    expect(maxed).toBeLessThanOrEqual(100);
    const minimal = scoreHistoryEntry(
      entry({ visitCount: 0, title: undefined, lastVisitedAt: NOW - 365 * 24 * 60 * 60 * 1000, normalizedUrl: "https://x.example/" }),
      NOW
    );
    expect(minimal).toBeGreaterThanOrEqual(0);
  });

  it("scores a highly-visited recent page above the suggested threshold", () => {
    expect(scoreHistoryEntry(entry({ visitCount: 8, lastVisitedAt: NOW, distinctDayCount: 3 }), NOW)).toBeGreaterThanOrEqual(
      SUGGESTED_SCORE_THRESHOLD
    );
  });
});

describe("describeHistoryEntry", () => {
  it("describes a single visit today", () => {
    expect(describeHistoryEntry(entry({ visitCount: 1, lastVisitedAt: NOW }), NOW)).toEqual([
      "Visited once",
      "Last visited today",
    ]);
  });

  it("describes multiple visits a few days ago", () => {
    const threeDaysAgo = NOW - 3 * 24 * 60 * 60 * 1000;
    expect(describeHistoryEntry(entry({ visitCount: 5, lastVisitedAt: threeDaysAgo }), NOW)).toEqual([
      "Visited 5 times",
      "Last visited 3 days ago",
    ]);
  });
});

describe("candidateLabel", () => {
  it("labels a heavily-visited page as frequently visited", () => {
    expect(candidateLabel(entry({ visitCount: 6 }), NOW)).toBe("Frequently visited");
  });

  it("labels a page visited more than once as revisited", () => {
    expect(candidateLabel(entry({ visitCount: 2, distinctDayCount: 1 }), NOW)).toBe("Revisited");
  });

  it("labels a single very recent visit as recently visited", () => {
    expect(candidateLabel(entry({ visitCount: 1, distinctDayCount: 1, lastVisitedAt: NOW }), NOW)).toBe("Recently visited");
  });

  it("falls back to potentially useful for an older single visit", () => {
    expect(
      candidateLabel(entry({ visitCount: 1, distinctDayCount: 1, lastVisitedAt: NOW - 10 * 24 * 60 * 60 * 1000 }), NOW)
    ).toBe("Potentially useful");
  });
});
