import { describe, expect, it } from "vitest";
import {
  REDUNDANCY_THRESHOLD,
  RedundancyIndex,
  buildSignature,
  calculateRedundancy,
  pairRedundancy,
} from "./redundancy";

function sig(url: string, title?: string) {
  return buildSignature({ url, title });
}

/** The decision the selection layer actually makes, so these tests assert behaviour rather than a tuning constant. */
function isRedundant(a: ReturnType<typeof sig>, b: ReturnType<typeof sig>): boolean {
  return pairRedundancy(a, b).score >= REDUNDANCY_THRESHOLD;
}

describe("pairRedundancy — the same resource", () => {
  it("calls two URL variants of one page fully redundant", () => {
    const assessment = pairRedundancy(
      sig("https://example.com/article?utm_source=x", "Price Mechanism Explained"),
      sig("https://www.example.com/article/", "Price Mechanism Explained")
    );
    expect(assessment).toEqual({ score: 1, reason: "duplicate-resource" });
  });

  it("calls one video reached two ways fully redundant", () => {
    expect(pairRedundancy(sig("https://youtu.be/AAA", "Lecture"), sig("https://youtube.com/watch?v=AAA&t=120", "Lecture")).reason).toBe(
      "duplicate-resource"
    );
  });
});

describe("pairRedundancy — the same page under different URLs", () => {
  it("collapses an identical title on one site", () => {
    const assessment = pairRedundancy(
      sig("https://news.example/2026/01/price-mechanism", "Price Mechanism Explained"),
      sig("https://news.example/amp/price-mechanism-explained", "Price Mechanism Explained")
    );
    expect(assessment.reason).toBe("same-page");
    expect(assessment.score).toBeGreaterThanOrEqual(REDUNDANCY_THRESHOLD);
  });

  it("keeps an identical title across two publishers, which is two takes on one story", () => {
    expect(
      isRedundant(sig("https://a.example/x", "Price Mechanism Explained"), sig("https://b.example/y", "Price Mechanism Explained"))
    ).toBe(false);
  });

  it("collapses two versions of one documentation page", () => {
    expect(
      isRedundant(sig("https://docs.example.com/api/v1/users", "Users — API 1.0 docs"), sig("https://docs.example.com/api/v2/users", "Users — API 2.0 docs"))
    ).toBe(true);
  });
});

describe("pairRedundancy — similar titles that are still different resources", () => {
  it("keeps a lecture series apart from its introduction", () => {
    expect(
      isRedundant(sig("https://uni.example/econ/1", "Introduction to Economics"), sig("https://uni.example/econ/2", "Introduction to Economics — Lecture 2"))
    ).toBe(false);
  });

  it("keeps sibling documentation pages on one site apart", () => {
    expect(
      isRedundant(sig("https://react.dev/reference/react/useMemo", "useMemo – React"), sig("https://react.dev/reference/react/useEffect", "useEffect – React"))
    ).toBe(false);
  });

  it("keeps unrelated pages on one site apart", () => {
    expect(isRedundant(sig("https://example.com/a", "Quantum Field Theory"), sig("https://example.com/b", "Sourdough Starter Guide"))).toBe(false);
  });

  it("does not collapse two one-word titles, which carry too little signal", () => {
    expect(isRedundant(sig("https://example.com/a", "Notes"), sig("https://example.com/b", "Notes!"))).toBe(false);
  });
});

describe("pairRedundancy — searches", () => {
  it("penalizes a trivial variation of one search", () => {
    const assessment = pairRedundancy(
      sig("https://find.example/search?q=ib+economics+price+mechanism+notes", "Search"),
      sig("https://find.example/search?q=ib+economics+price+mechanism", "Search")
    );
    expect(assessment.reason).toBe("similar-search");
    expect(assessment.score).toBeGreaterThanOrEqual(REDUNDANCY_THRESHOLD);
  });

  it("leaves two genuinely different searches alone", () => {
    expect(
      isRedundant(sig("https://find.example/search?q=python+pandas", "Search"), sig("https://find.example/search?q=rust+ownership", "Search"))
    ).toBe(false);
  });

  it("does not treat a search page as redundant with an article it led to", () => {
    expect(
      isRedundant(sig("https://find.example/search?q=price+mechanism", "Search"), sig("https://find.example/articles/price-mechanism", "Price Mechanism"))
    ).toBe(false);
  });
});

describe("pairRedundancy — different resource types on one topic", () => {
  it("keeps an encyclopedia entry, a paper and a lecture video all distinct", () => {
    const wiki = sig("https://en.wikipedia.org/wiki/Price_mechanism", "Price mechanism - Wikipedia");
    const paper = sig("https://lse.example/papers/price-mechanism.pdf", "The Price Mechanism: A Research Paper");
    const video = sig("https://youtube.com/watch?v=AAA", "Price Mechanism Explained");

    expect(isRedundant(paper, wiki)).toBe(false);
    expect(isRedundant(video, wiki)).toBe(false);
    expect(isRedundant(video, paper)).toBe(false);
  });
});

describe("calculateRedundancy", () => {
  it("reports the strongest match across everything already chosen", () => {
    const chosen = [sig("https://a.example/x", "Unrelated Thing"), sig("https://example.com/article", "Price Mechanism Explained")];
    const assessment = calculateRedundancy(sig("https://example.com/article?utm_source=n", "Price Mechanism Explained"), chosen);
    expect(assessment).toEqual({ score: 1, reason: "duplicate-resource" });
  });

  it("reports nothing against an empty selection", () => {
    expect(calculateRedundancy(sig("https://example.com/a", "Anything At All"), [])).toEqual({ score: 0 });
  });
});

describe("RedundancyIndex", () => {
  it("matches what an exhaustive comparison would find", () => {
    const chosen = [
      sig("https://example.com/article", "Price Mechanism Explained"),
      sig("https://youtube.com/watch?v=AAA", "Price Mechanism Explained"),
      sig("https://find.example/search?q=price+mechanism", "Search"),
    ];
    const probes = [
      sig("https://example.com/article?utm_source=x", "Price Mechanism Explained"),
      sig("https://youtube.com/watch?v=BBB", "Demand And Supply Explained"),
      sig("https://find.example/search?q=price+mechanism+notes", "Search"),
      sig("https://example.com/other", "Something Else Entirely"),
    ];

    const index = new RedundancyIndex();
    for (const signature of chosen) index.add(signature);

    for (const probe of probes) {
      expect(index.assess(probe)).toEqual(calculateRedundancy(probe, chosen));
    }
  });

  it("stays fast on a large single-site selection", () => {
    const index = new RedundancyIndex();
    const started = Date.now();
    for (let i = 0; i < 3000; i++) {
      const signature = sig(`https://example.com/page-${i}`, `Distinct Article Number ${i} About Topic ${i}`);
      index.assess(signature);
      index.add(signature);
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
