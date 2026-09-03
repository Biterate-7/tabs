import { describe, expect, it } from "vitest";
import { deriveClusterName, deriveSectionName, domainTokens, tabTokens, tokenOverlap, tokenize } from "./keywords";

describe("tokenize", () => {
  it("lowercases, splits on non-alnum, and drops stopwords/short tokens", () => {
    expect(tokenize("The Quick Fox: A Guide")).toEqual(["quick", "fox"]);
  });

  it("drops purely numeric tokens", () => {
    expect(tokenize("2024 Election Results")).toEqual(["election"]);
  });
});

describe("domainTokens", () => {
  it("strips a common TLD before tokenizing", () => {
    expect(domainTokens("github.com")).toEqual(["github"]);
  });
});

describe("tabTokens", () => {
  it("boosts known dev-tool domains with a synthetic 'development' token", () => {
    expect(tabTokens({ title: "some repo", domain: "github.com" })).toContain("development");
  });
});

describe("deriveClusterName", () => {
  it("picks the most frequent shared token across the cluster's titles", () => {
    const name = deriveClusterName([
      { title: "Physics IA Notes", domain: "docs.google.com" },
      { title: "Physics Orbital Mechanics", domain: "wikipedia.org" },
      { title: "Physics Lab Report", domain: "notion.so" },
    ]);
    expect(name).toBe("Physics");
  });

  it("preserves a short all-caps acronym's casing", () => {
    const name = deriveClusterName([
      { title: "MUN Resolution Draft", domain: "un.org" },
      { title: "MUN Position Paper", domain: "un.org" },
    ]);
    expect(name).toBe("MUN");
  });

  it("combines two strongly co-occurring tokens", () => {
    const name = deriveClusterName([
      { title: "College Research List", domain: "collegeboard.org" },
      { title: "College Research Notes", domain: "collegeboard.org" },
      { title: "College Research Deadlines", domain: "commonapp.org" },
    ]);
    expect(name).toBe("College Research");
  });

  it("falls back to Miscellaneous when nothing is significant", () => {
    expect(deriveClusterName([{ title: "", domain: "" }])).toBe("Miscellaneous");
  });
});

describe("deriveSectionName", () => {
  it("uses the brand name when a majority of the group shares one site, even with unrelated titles", () => {
    const name = deriveSectionName([
      { title: "Instagram", domain: "www.instagram.com" },
      { title: "Login • Instagram", domain: "m.instagram.com" },
      { title: "jane_doe • Instagram photos and videos", domain: "instagram.com" },
    ]);
    expect(name).toBe("Instagram");
  });

  it("falls back to topic-derived naming when no site dominates", () => {
    const name = deriveSectionName([
      { title: "Physics IA Notes", domain: "docs.google.com" },
      { title: "Physics Orbital Mechanics", domain: "wikipedia.org" },
      { title: "Physics Lab Report", domain: "notion.so" },
    ]);
    expect(name).toBe("Physics");
  });

  it("does not let a bare google.com/bing.com majority produce a meaningless 'Google' section", () => {
    const name = deriveSectionName([
      { title: "a - Google Search", domain: "google.com" },
      { title: "b - Google Search", domain: "google.com" },
    ]);
    expect(name).not.toBe("Google");
  });
});

describe("tokenOverlap", () => {
  it("returns 0 for disjoint sets and 1 for identical sets", () => {
    expect(tokenOverlap(["a", "b"], ["c", "d"])).toBe(0);
    expect(tokenOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });
});
