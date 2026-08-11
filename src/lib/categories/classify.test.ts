import { describe, expect, it } from "vitest";
import { classifyUrl, scoreUrl } from "./classify";

describe("scoreUrl", () => {
  it("returns a score for every category, defaulting to 0", () => {
    const scores = scoreUrl("https://example.com/");
    expect(Object.keys(scores)).toHaveLength(8);
    expect(scores.other).toBe(0);
  });

  it("sums multiple matching rules for the same category", () => {
    const scores = scoreUrl("https://docs.google.com/document/course-notes");
    expect(scores.school).toBeGreaterThan(55);
  });
});

describe("classifyUrl", () => {
  it("classifies GitHub as Projects with high confidence", () => {
    const result = classifyUrl("https://github.com/foo/bar");
    expect(result.category).toBe("projects");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies GitLab as Projects with high confidence", () => {
    const result = classifyUrl("https://gitlab.com/foo/bar");
    expect(result.category).toBe("projects");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies arXiv as Research with high confidence", () => {
    const result = classifyUrl("https://arxiv.org/abs/1234.5678");
    expect(result.category).toBe("research");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies Google Scholar as Research", () => {
    const result = classifyUrl("https://scholar.google.com/citations?user=1");
    expect(result.category).toBe("research");
  });

  it("classifies Wikipedia as Research with medium confidence", () => {
    const result = classifyUrl("https://en.wikipedia.org/wiki/Cat");
    expect(result.category).toBe("research");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("classifies Amazon as Shopping", () => {
    const result = classifyUrl("https://www.amazon.in/dp/B0ABCDEFG");
    expect(result.category).toBe("shopping");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies Flipkart as Shopping", () => {
    const result = classifyUrl("https://www.flipkart.com/product/p/itm1");
    expect(result.category).toBe("shopping");
  });

  it("classifies Google Classroom as School", () => {
    const result = classifyUrl("https://classroom.google.com/c/abc123");
    expect(result.category).toBe("school");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies Canva as Creative", () => {
    const result = classifyUrl("https://www.canva.com/design/DAF.../edit");
    expect(result.category).toBe("creative");
  });

  it("classifies Figma as Creative over Projects (higher weight wins)", () => {
    const result = classifyUrl("https://www.figma.com/file/abc/My-Design");
    expect(result.category).toBe("creative");
    expect(result.scores.projects).toBeGreaterThan(0);
    expect(result.scores.creative).toBeGreaterThan(result.scores.projects);
  });

  it("classifies YouTube as Other (no strong signal defined for it yet)", () => {
    const result = classifyUrl("https://www.youtube.com/watch?v=abc123");
    expect(result.category).toBe("other");
  });

  it("classifies a major news site as News", () => {
    const result = classifyUrl(
      "https://www.bbc.com/news/world-europe-12345678"
    );
    expect(result.category).toBe("news");
  });

  it("classifies an unknown site as Other with low confidence", () => {
    const result = classifyUrl("https://totally-unknown-site-xyz123.com/");
    expect(result.category).toBe("other");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("classifies an ambiguous personal blog as Read Later, not confidently something else", () => {
    const result = classifyUrl("https://someone.substack.com/p/my-thoughts");
    expect(result.category).toBe("read-later");
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("never returns a confidence above 1", () => {
    const result = classifyUrl("https://github.com/foo/bar");
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("classifies 250 mixed URLs quickly", () => {
    const domains = [
      "github.com/a",
      "arxiv.org/abs/1",
      "amazon.in/dp/x",
      "totally-unknown-xyz.com/",
      "canva.com/design/1",
    ];
    const urls = Array.from(
      { length: 250 },
      (_, i) => `https://${domains[i % domains.length]}?n=${i}`
    );
    const start = performance.now();
    for (const url of urls) classifyUrl(url);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
