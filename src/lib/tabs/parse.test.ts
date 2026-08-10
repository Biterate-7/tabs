import { describe, expect, it } from "vitest";
import { splitInput, parseUrls } from "./parse";

describe("splitInput", () => {
  it("splits on newlines", () => {
    expect(splitInput("https://a.com\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on commas", () => {
    expect(splitInput("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on spaces", () => {
    expect(splitInput("https://a.com https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on tabs and mixed whitespace/commas", () => {
    expect(splitInput("https://a.com\t,\nhttps://b.com  https://c.com")).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("drops empty tokens and trims", () => {
    expect(splitInput("  \n\n , , https://a.com  ")).toEqual(["https://a.com"]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitInput("")).toEqual([]);
    expect(splitInput("   \n\t  ")).toEqual([]);
  });
});

describe("parseUrls", () => {
  it("parses well-formed URLs and assigns ids/domains", () => {
    const { tabs, invalidCount } = parseUrls(
      "https://github.com/foo\nhttps://arxiv.org/abs/1"
    );
    expect(invalidCount).toBe(0);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].domain).toBe("github.com");
    expect(tabs[0].url).toBe("https://github.com/foo");
    expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
  });

  it("adds https:// to bare domains", () => {
    const { tabs, invalidCount } = parseUrls("github.com/foo");
    expect(invalidCount).toBe(0);
    expect(tabs[0].url).toBe("https://github.com/foo");
  });

  it("counts garbage tokens as invalid without throwing", () => {
    expect(() => parseUrls("not a url, ///, ,,,")).not.toThrow();
    const { tabs, invalidCount } = parseUrls("not a url, https://a.com");
    expect(tabs).toHaveLength(1);
    expect(invalidCount).toBeGreaterThan(0);
  });

  it("handles empty input", () => {
    const { tabs, invalidCount } = parseUrls("");
    expect(tabs).toEqual([]);
    expect(invalidCount).toBe(0);
  });

  it("handles mixed valid and invalid content", () => {
    const { tabs, invalidCount } = parseUrls(
      "https://github.com/a, garbage, https://arxiv.org/b, alsogarbage"
    );
    expect(tabs).toHaveLength(2);
    expect(invalidCount).toBe(2);
  });

  it("remains fast and correct for 250 URLs", () => {
    const input = Array.from(
      { length: 250 },
      (_, i) => `https://example.com/page-${i}`
    ).join("\n");
    const start = performance.now();
    const { tabs, invalidCount } = parseUrls(input);
    const elapsed = performance.now() - start;
    expect(tabs).toHaveLength(250);
    expect(invalidCount).toBe(0);
    expect(elapsed).toBeLessThan(200);
  });
});
