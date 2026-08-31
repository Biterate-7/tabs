import { describe, expect, it } from "vitest";
import { isNoiseUrl } from "./filter";

describe("isNoiseUrl", () => {
  it("filters browser-internal and non-web schemes", () => {
    expect(isNoiseUrl("chrome://settings")).toBe(true);
    expect(isNoiseUrl("edge://extensions")).toBe(true);
    expect(isNoiseUrl("about:blank")).toBe(true);
    expect(isNoiseUrl("chrome-extension://abcdefg/popup.html")).toBe(true);
    expect(isNoiseUrl("file:///Users/me/notes.txt")).toBe(true);
    expect(isNoiseUrl("javascript:void(0)")).toBe(true);
  });

  it("filters blank or unparseable urls", () => {
    expect(isNoiseUrl("")).toBe(true);
    expect(isNoiseUrl("   ")).toBe(true);
    expect(isNoiseUrl("not a url")).toBe(true);
  });

  it("filters obvious login/auth pages", () => {
    expect(isNoiseUrl("https://accounts.google.com/signin/v2/identifier")).toBe(true);
    expect(isNoiseUrl("https://login.microsoftonline.com/common/oauth2/authorize")).toBe(true);
    expect(isNoiseUrl("https://example.com/login")).toBe(true);
    expect(isNoiseUrl("https://example.com/auth/callback")).toBe(true);
    expect(isNoiseUrl("https://github.com/session")).toBe(false); // "session" alone isn't a strong enough signal
  });

  it("filters checkout/payment pages", () => {
    expect(isNoiseUrl("https://shop.example.com/checkout")).toBe(true);
    expect(isNoiseUrl("https://shop.example.com/billing")).toBe(true);
    expect(isNoiseUrl("https://shop.example.com/cart/checkout")).toBe(true);
  });

  it("filters search-result pages on major engines", () => {
    expect(isNoiseUrl("https://www.google.com/search?q=react+hooks")).toBe(true);
    expect(isNoiseUrl("https://www.bing.com/search?q=react")).toBe(true);
    expect(isNoiseUrl("https://duckduckgo.com/html?q=react")).toBe(true);
  });

  it("does not filter a normal page just because it lives on a search engine's domain", () => {
    expect(isNoiseUrl("https://www.google.com/maps/place/somewhere")).toBe(false);
  });

  it("filters obvious error-page titles", () => {
    expect(isNoiseUrl("https://example.com/deleted-post", "404")).toBe(true);
    expect(isNoiseUrl("https://example.com/deleted-post", "Page Not Found")).toBe(true);
  });

  it("does not filter a title that merely mentions an error in passing", () => {
    expect(isNoiseUrl("https://example.com/blog/debugging-404-errors", "How I Debugged a 404 Error")).toBe(false);
  });

  it("never filters ordinary content sites", () => {
    expect(isNoiseUrl("https://en.wikipedia.org/wiki/Tab_(interface)")).toBe(false);
    expect(isNoiseUrl("https://www.reddit.com/r/programming/comments/abc123")).toBe(false);
    expect(isNoiseUrl("https://www.youtube.com/watch?v=abc123")).toBe(false);
    expect(isNoiseUrl("https://github.com/vercel/next.js")).toBe(false);
    expect(isNoiseUrl("https://docs.google.com/document/d/abc123")).toBe(false);
    expect(isNoiseUrl("https://arxiv.org/abs/2301.00001")).toBe(false);
    expect(isNoiseUrl("https://www.nytimes.com/2026/01/01/world/some-article.html")).toBe(false);
    expect(isNoiseUrl("https://example.blogspot.com/2026/01/a-post.html")).toBe(false);
    expect(isNoiseUrl("https://shop.example.com/products/some-item")).toBe(false); // a product page is not checkout
  });
});
