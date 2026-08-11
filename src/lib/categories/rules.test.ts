import { describe, expect, it } from "vitest";
import { RULES } from "./rules";
import { toUrlContext } from "./context";

function matchingCategories(url: string): string[] {
  const ctx = toUrlContext(url);
  return RULES.filter((r) => r.test(ctx)).map((r) => r.category);
}

describe("RULES", () => {
  it("has at least one rule per category except other", () => {
    const categories = new Set(RULES.map((r) => r.category));
    for (const id of [
      "research",
      "school",
      "projects",
      "shopping",
      "creative",
      "news",
      "read-later",
    ]) {
      expect(categories.has(id as never)).toBe(true);
    }
  });

  it("matches research high-confidence domains", () => {
    for (const url of [
      "https://arxiv.org/abs/1234",
      "https://scholar.google.com/citations",
      "https://pubmed.ncbi.nlm.nih.gov/12345",
      "https://www.researchgate.net/publication/1",
      "https://www.jstor.org/stable/1",
      "https://www.semanticscholar.org/paper/1",
    ]) {
      expect(matchingCategories(url)).toContain("research");
    }
  });

  it("matches school high-confidence domains", () => {
    for (const url of [
      "https://classroom.google.com/c/1",
      "https://canvas.instructure.com/courses/1",
      "https://moodle.org/course/view.php",
    ]) {
      expect(matchingCategories(url)).toContain("school");
    }
  });

  it("matches projects high-confidence domains", () => {
    for (const url of [
      "https://github.com/foo/bar",
      "https://gitlab.com/foo/bar",
      "https://bitbucket.org/foo/bar",
      "https://vercel.com/dashboard",
      "https://supabase.com/dashboard",
      "https://linear.app/team/issue/1",
    ]) {
      expect(matchingCategories(url)).toContain("projects");
    }
  });

  it("matches shopping high-confidence domains across TLDs", () => {
    for (const url of [
      "https://www.amazon.com/dp/xyz",
      "https://www.amazon.in/dp/xyz",
      "https://www.flipkart.com/product/1",
      "https://www.myntra.com/product/1",
      "https://www.ebay.com/itm/1",
      "https://www.etsy.com/listing/1",
    ]) {
      expect(matchingCategories(url)).toContain("shopping");
    }
  });

  it("matches creative high-confidence domains", () => {
    for (const url of [
      "https://www.canva.com/design/1",
      "https://www.figma.com/file/1",
      "https://www.behance.net/gallery/1",
      "https://dribbble.com/shots/1",
      "https://www.pinterest.com/pin/1",
    ]) {
      expect(matchingCategories(url)).toContain("creative");
    }
  });

  it("matches known news domains", () => {
    for (const url of [
      "https://www.bbc.com/news/1",
      "https://www.nytimes.com/2026/01/01/world/article.html",
      "https://www.reuters.com/world/1",
      "https://www.theguardian.com/world/1",
    ]) {
      expect(matchingCategories(url)).toContain("news");
    }
  });

  it("matches read-later blog/docs signals", () => {
    for (const url of [
      "https://someblog.substack.com/p/my-post",
      "https://dev.to/someone/a-post",
      "https://docs.example.com/getting-started",
      "https://example.com/blog/my-long-post",
    ]) {
      expect(matchingCategories(url)).toContain("read-later");
    }
  });

  it("gives figma both creative (high) and projects (medium) signals", () => {
    const cats = matchingCategories("https://www.figma.com/file/1");
    expect(cats).toContain("creative");
    expect(cats).toContain("projects");
  });
});
