import { describe, expect, it } from "vitest";
import { buildTabsFromBrowserImport } from "./browser-import";

describe("buildTabsFromBrowserImport", () => {
  it("converts entries into Tabs using the same parsing as pasted text", () => {
    const tabs = buildTabsFromBrowserImport([{ url: "https://github.com/foo/bar" }]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].domain).toBe("github.com");
    expect(tabs[0].url).toBe("https://github.com/foo/bar");
  });

  it("keeps the browser-provided title as-is", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://github.com/foo/bar", title: "foo/bar: A cool repo" },
    ]);
    expect(tabs[0].title).toBe("foo/bar: A cool repo");
  });

  it("trims whitespace from a browser-provided title and omits it if blank", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://a.example", title: "  Padded Title  " },
      { url: "https://b.example", title: "   " },
    ]);
    expect(tabs[0].title).toBe("Padded Title");
    expect(tabs[1].title).toBeUndefined();
  });

  it("carries pinned state through when provided", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://a.example", pinned: true },
      { url: "https://b.example", pinned: false },
      { url: "https://c.example" },
    ]);
    expect(tabs[0].pinned).toBe(true);
    expect(tabs[1].pinned).toBe(false);
    expect(tabs[2].pinned).toBeUndefined();
  });

  it("carries a favicon through when provided, omitting it otherwise", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://a.example", favicon: "https://a.example/favicon.ico" },
      { url: "https://b.example" },
    ]);
    expect(tabs[0].favicon).toBe("https://a.example/favicon.ico");
    expect(tabs[1].favicon).toBeUndefined();
  });

  it("skips malformed URLs instead of throwing", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "not a url" },
      { url: "https://github.com/ok" },
    ]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].domain).toBe("github.com");
  });

  it("returns an empty array for an empty batch", () => {
    expect(buildTabsFromBrowserImport([])).toEqual([]);
  });

  it("categorizes the resulting tabs", () => {
    const tabs = buildTabsFromBrowserImport([{ url: "https://github.com/foo/bar" }]);
    expect(tabs[0].category).toBe("projects");
  });

  it("handles a large batch (200 tabs) correctly and quickly", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      title: `Page ${i}`,
    }));
    const start = performance.now();
    const tabs = buildTabsFromBrowserImport(entries);
    const elapsed = performance.now() - start;
    expect(tabs).toHaveLength(200);
    expect(tabs[199].title).toBe("Page 199");
    expect(elapsed).toBeLessThan(500);
  });

  it("does not de-duplicate on its own (caller's responsibility across merges)", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://a.example" },
      { url: "https://a.example" },
    ]);
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => !t.isDuplicate)).toBe(true);
  });

  it("strips the browser's own Google Docs/Sheets/Slides suffix from a Google Docs URL's title", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://docs.google.com/document/d/abc/edit", title: "My Research Paper - Google Docs" },
      { url: "https://docs.google.com/spreadsheets/d/abc/edit", title: "Q3 Budget - Google Sheets" },
      { url: "https://docs.google.com/presentation/d/abc/edit", title: "Pitch Deck - Google Slides" },
    ]);
    expect(tabs[0].title).toBe("My Research Paper");
    expect(tabs[1].title).toBe("Q3 Budget");
    expect(tabs[2].title).toBe("Pitch Deck");
  });

  it("does not strip a Google-Docs-style suffix from a non-Google-Docs URL's title", () => {
    const tabs = buildTabsFromBrowserImport([
      { url: "https://example.com/page", title: "Something - Google Docs" },
    ]);
    expect(tabs[0].title).toBe("Something - Google Docs");
  });
});
