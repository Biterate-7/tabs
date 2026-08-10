import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./normalize";

describe("normalizeUrl", () => {
  it("lowercases the hostname", () => {
    expect(normalizeUrl(new URL("https://GitHub.com/foo"))).toBe(
      "https://github.com/foo"
    );
  });

  it("strips a trailing slash", () => {
    expect(normalizeUrl(new URL("https://example.com/page/"))).toBe(
      "https://example.com/page"
    );
  });

  it("removes utm_ and click-id tracking params", () => {
    const url = new URL(
      "https://example.com/page?utm_source=x&utm_medium=y&utm_campaign=z&utm_term=t&utm_content=c&fbclid=1&gclid=2&keep=me"
    );
    expect(normalizeUrl(url)).toBe("https://example.com/page?keep=me");
  });

  it("drops the hash fragment", () => {
    expect(normalizeUrl(new URL("https://example.com/page#section"))).toBe(
      "https://example.com/page"
    );
  });

  it("treats two URLs differing only by tracking params as equal", () => {
    const a = normalizeUrl(new URL("https://example.com/page?utm_source=test"));
    const b = normalizeUrl(new URL("https://example.com/page"));
    expect(a).toBe(b);
  });

  it("sorts remaining query params for stable comparison", () => {
    const a = normalizeUrl(new URL("https://example.com/page?b=2&a=1"));
    const b = normalizeUrl(new URL("https://example.com/page?a=1&b=2"));
    expect(a).toBe(b);
  });
});
