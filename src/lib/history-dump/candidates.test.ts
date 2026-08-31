import { describe, expect, it } from "vitest";
import { buildHistoryCandidates } from "./candidates";
import type { HistoryVisitItem } from "@/lib/browser/protocol";

const NOW = new Date(2026, 0, 31).getTime();

function item(over: Partial<HistoryVisitItem>): HistoryVisitItem {
  return { url: "https://example.com/article", title: "Article", lastVisitTime: NOW, visitCount: 1, historyItemId: "1", ...over };
}

describe("buildHistoryCandidates", () => {
  it("filters noise before scoring", () => {
    const result = buildHistoryCandidates(
      [item({ url: "chrome://settings" }), item({ url: "https://accounts.google.com/signin" })],
      new Set(),
      NOW
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.scannedCount).toBe(2);
  });

  it("deduplicates and scores the remaining entries", () => {
    const result = buildHistoryCandidates(
      [
        item({ url: "https://en.wikipedia.org/wiki/Tab", title: "Tab (interface)", visitCount: 8, lastVisitTime: NOW }),
        item({ url: "https://example.com/random", title: "x", visitCount: 1, lastVisitTime: NOW - 15 * 24 * 60 * 60 * 1000 }),
      ],
      new Set(),
      NOW
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].url).toBe("https://en.wikipedia.org/wiki/Tab");
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score);
  });

  it("sorts candidates by score descending", () => {
    const result = buildHistoryCandidates(
      [
        item({ url: "https://a.example/page", visitCount: 1, lastVisitTime: NOW - 20 * 24 * 60 * 60 * 1000 }),
        item({ url: "https://b.example/page", visitCount: 9, lastVisitTime: NOW }),
      ],
      new Set(),
      NOW
    );
    expect(result.candidates.map((c) => c.domain)).toEqual(["b.example", "a.example"]);
  });

  it("tiers high-scoring candidates as suggested and the rest as other", () => {
    const result = buildHistoryCandidates(
      [
        item({ url: "https://strong.example/page", title: "A Strong Signal Page", visitCount: 8, lastVisitTime: NOW }),
        item({ url: "https://weak.example/page", title: "x", visitCount: 1, lastVisitTime: NOW - 18 * 24 * 60 * 60 * 1000 }),
      ],
      new Set(),
      NOW
    );
    const strong = result.candidates.find((c) => c.domain === "strong.example")!;
    const weak = result.candidates.find((c) => c.domain === "weak.example")!;
    expect(strong.tier).toBe("suggested");
    expect(weak.tier).toBe("other");
  });

  it("flags candidates already present in the workspace, without excluding them", () => {
    const result = buildHistoryCandidates(
      [item({ url: "https://example.com/article" })],
      new Set(["https://example.com/article"]),
      NOW
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].alreadyInWorkspace).toBe(true);
  });

  it("does not flag a candidate not present in the workspace", () => {
    const result = buildHistoryCandidates([item({ url: "https://example.com/article" })], new Set(["https://other.example/"]), NOW);
    expect(result.candidates[0].alreadyInWorkspace).toBe(false);
  });

  it("returns an empty candidate list for empty input", () => {
    const result = buildHistoryCandidates([], new Set(), NOW);
    expect(result.candidates).toEqual([]);
    expect(result.scannedCount).toBe(0);
  });
});
