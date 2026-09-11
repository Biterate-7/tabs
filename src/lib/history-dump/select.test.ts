import { describe, expect, it } from "vitest";
import { selectDiverseSuggestions } from "./select";
import { canonicalResourceKey } from "./resource-key";
import type { HistoryCandidate } from "./types";

const NOW = new Date(2026, 0, 31).getTime();

function candidate(url: string, title: string, over: Partial<HistoryCandidate> = {}): HistoryCandidate {
  return {
    id: url,
    url,
    normalizedUrl: url,
    resourceKey: canonicalResourceKey(url),
    domain: new URL(url).hostname,
    title,
    visitCount: 1,
    lastVisitedAt: NOW,
    score: 60,
    tier: "suggested",
    reasons: ["Recently visited"],
    alreadyInWorkspace: false,
    ...over,
  };
}

function select(candidates: HistoryCandidate[]): string[] {
  return selectDiverseSuggestions(candidates).selectedIds;
}

describe("selectDiverseSuggestions — exact duplicates", () => {
  it("selects one of several identical entries", () => {
    const a = candidate("https://example.com/article", "Article");
    const selected = select([a, { ...a, id: "b" }, { ...a, id: "c" }]);
    expect(selected).toEqual([a.id]);
  });

  it("selects one representative across tracking-parameter variants", () => {
    const selected = select([
      candidate("https://example.com/article?utm_source=x", "Article"),
      candidate("https://example.com/article?utm_source=y", "Article"),
      candidate("https://example.com/article", "Article"),
    ]);
    expect(selected).toHaveLength(1);
  });

  it("selects one representative across URL fragments", () => {
    const selected = select([
      candidate("https://example.com/article#section1", "Article"),
      candidate("https://example.com/article#section2", "Article"),
      candidate("https://example.com/article", "Article"),
    ]);
    expect(selected).toHaveLength(1);
  });

  it("selects one representative for a video reached with different timestamps", () => {
    const selected = select([
      candidate("https://youtube.com/watch?v=AAA&t=30", "Price Mechanism Explained"),
      candidate("https://youtube.com/watch?v=AAA&t=120", "Price Mechanism Explained"),
    ]);
    expect(selected).toHaveLength(1);
  });

  it("keeps two different videos", () => {
    const selected = select([
      candidate("https://youtube.com/watch?v=AAA", "Price Mechanism Explained"),
      candidate("https://youtube.com/watch?v=BBB", "Demand And Supply Explained"),
    ]);
    expect(selected).toHaveLength(2);
  });
});

describe("selectDiverseSuggestions — near duplicates", () => {
  it("keeps one of several trivial variations of the same search", () => {
    const selected = select([
      candidate("https://find.example/search?q=ib+economics+price+mechanism", "Search"),
      candidate("https://find.example/search?q=ib+economics+price+mechanism+notes", "Search"),
      candidate("https://find.example/search?q=ib+economics+price+mechanism+explanation", "Search"),
    ]);
    expect(selected).toHaveLength(1);
  });

  it("keeps searches on genuinely different questions", () => {
    const selected = select([
      candidate("https://find.example/search?q=price+mechanism", "Search"),
      candidate("https://find.example/search?q=sourdough+starter+troubleshooting", "Search"),
    ]);
    expect(selected).toHaveLength(2);
  });

  it("keeps one copy of an article reachable through several URLs", () => {
    const selected = select([
      candidate("https://news.example/2026/01/price-mechanism", "Price Mechanism Explained"),
      candidate("https://news.example/story/price-mechanism-explained", "Price Mechanism Explained"),
    ]);
    expect(selected).toHaveLength(1);
  });
});

describe("selectDiverseSuggestions — what must survive", () => {
  it("keeps different resource types covering one topic", () => {
    const selected = select([
      candidate("https://en.wikipedia.org/wiki/Price_mechanism", "Price mechanism - Wikipedia"),
      candidate("https://lse.example/papers/price-mechanism", "The Price Mechanism: A Research Paper"),
      candidate("https://youtube.com/watch?v=AAA", "Price Mechanism Lecture"),
      candidate("https://ibnotes.example/price-mechanism", "IB Economics — Price Mechanism Notes"),
    ]);
    expect(selected).toHaveLength(4);
  });

  it("keeps many useful pages from one domain", () => {
    const selected = select([
      candidate("https://react.dev/reference/react/hooks", "Built-in React Hooks"),
      candidate("https://react.dev/reference/react/useEffect", "useEffect – React"),
      candidate("https://react.dev/reference/react/useMemo", "useMemo – React"),
      candidate("https://react.dev/learn/passing-data-deeply-with-context", "Passing Data Deeply with Context"),
    ]);
    expect(selected).toHaveLength(4);
  });

  it("keeps a programming workspace's complementary resources from five different sites", () => {
    const selected = select([
      candidate("https://github.com/facebook/react", "facebook/react: The library for web UIs"),
      candidate("https://developer.mozilla.org/en-US/docs/Web/API/fetch", "fetch() global function - MDN"),
      candidate("https://react.dev/learn", "Quick Start – React"),
      candidate("https://stackoverflow.com/questions/1234/why-does-useeffect-run-twice", "Why does useEffect run twice?"),
      candidate("https://npmjs.com/package/react", "react - npm"),
    ]);
    expect(selected).toHaveLength(5);
  });

  it("keeps a lecture series rather than collapsing it on title similarity", () => {
    const selected = select([
      candidate("https://uni.example/econ/1", "Introduction to Economics"),
      candidate("https://uni.example/econ/2", "Introduction to Economics — Lecture 2"),
    ]);
    expect(selected).toHaveLength(2);
  });

  it("passes ordinary non-redundant history through untouched", () => {
    const candidates = [
      candidate("https://a.example/one", "Sourdough Starter Troubleshooting"),
      candidate("https://b.example/two", "Wiring A Three Way Switch"),
      candidate("https://c.example/three", "Schwarzschild Metric Derivation"),
    ];
    const { selectedIds, skipped } = selectDiverseSuggestions(candidates);
    expect(selectedIds).toEqual(candidates.map((c) => c.id));
    expect(skipped).toEqual([]);
  });
});

describe("selectDiverseSuggestions — which of two redundant pages wins", () => {
  it("keeps the higher-scoring one regardless of input order", () => {
    const weak = candidate("https://example.com/article?utm_source=x", "Article", { id: "weak", score: 50 });
    const strong = candidate("https://example.com/article", "Article", { id: "strong", score: 90 });

    expect(select([weak, strong])).toEqual(["strong"]);
    expect(select([strong, weak])).toEqual(["strong"]);
  });

  it("breaks a score tie towards the more recently visited page", () => {
    const older = candidate("https://news.example/a", "Price Mechanism Explained", { id: "older", lastVisitedAt: NOW - 5000 });
    const newer = candidate("https://news.example/b", "Price Mechanism Explained", { id: "newer", lastVisitedAt: NOW });
    expect(select([older, newer])).toEqual(["newer"]);
  });
});

describe("selectDiverseSuggestions — reporting", () => {
  it("explains every candidate it passed over", () => {
    const { selectedIds, skipped } = selectDiverseSuggestions([
      candidate("https://example.com/article", "Price Mechanism Explained", { id: "keep", score: 90 }),
      candidate("https://example.com/article?utm_source=x", "Price Mechanism Explained", { id: "dup", score: 80 }),
      candidate("https://find.example/search?q=price+mechanism", "Search", { id: "search-a", score: 70 }),
      candidate("https://find.example/search?q=price+mechanism+notes", "Search", { id: "search-b", score: 60 }),
    ]);

    expect(selectedIds).toEqual(["keep", "search-a"]);
    expect(skipped).toEqual([
      { id: "dup", reason: "duplicate-resource", note: "Duplicate of another selected tab" },
      { id: "search-b", reason: "similar-search", note: "Similar search to another selected tab" },
    ]);
  });

  it("never selects a candidate the workspace already holds", () => {
    const { selectedIds } = selectDiverseSuggestions([
      candidate("https://example.com/saved", "Saved Article Already", { id: "saved", alreadyInWorkspace: true }),
      candidate("https://example.com/fresh", "A Fresh Article", { id: "fresh" }),
    ]);
    expect(selectedIds).toEqual(["fresh"]);
  });

  it("returns an empty selection for no candidates", () => {
    expect(selectDiverseSuggestions([])).toEqual({ selectedIds: [], skipped: [] });
  });
});
