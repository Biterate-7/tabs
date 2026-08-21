import { describe, expect, it } from "vitest";
import { isPrivilegedUrl, buildImportPayload } from "./tabs.js";

function fakeTab(over) {
  return {
    id: 1,
    windowId: 1,
    url: "https://example.com",
    title: "Example",
    pinned: false,
    active: false,
    ...over,
  };
}

describe("isPrivilegedUrl", () => {
  it("flags chrome://, chrome-extension://, and devtools:// as privileged", () => {
    expect(isPrivilegedUrl("chrome://extensions")).toBe(true);
    expect(isPrivilegedUrl("chrome-extension://abcdefg/popup.html")).toBe(true);
    expect(isPrivilegedUrl("devtools://devtools/bundled/inspector.html")).toBe(true);
  });

  it("flags about:, view-source:, and edge: as privileged", () => {
    expect(isPrivilegedUrl("about:blank")).toBe(true);
    expect(isPrivilegedUrl("view-source:https://example.com")).toBe(true);
    expect(isPrivilegedUrl("edge://settings")).toBe(true);
  });

  it("does not flag ordinary http(s) websites, however unusual their content", () => {
    expect(isPrivilegedUrl("https://github.com/foo/bar")).toBe(false);
    expect(isPrivilegedUrl("http://localhost:3000")).toBe(false);
    expect(isPrivilegedUrl("https://example.com/chrome-store")).toBe(false); // "chrome" in the path, not the scheme
  });

  it("treats an unparseable URL as privileged (excluded) rather than throwing", () => {
    expect(() => isPrivilegedUrl("not a url")).not.toThrow();
    expect(isPrivilegedUrl("not a url")).toBe(true);
  });
});

describe("buildImportPayload", () => {
  it("maps ordinary tabs into the wire shape", () => {
    const { tabs } = buildImportPayload([fakeTab({ url: "https://github.com/a", title: "A repo" })]);
    expect(tabs).toEqual([
      {
        url: "https://github.com/a",
        title: "A repo",
        pinned: false,
        active: false,
        tabId: 1,
        windowId: 1,
      },
    ]);
  });

  it("excludes privileged tabs but keeps ordinary ones from the same batch", () => {
    const { tabs } = buildImportPayload([
      fakeTab({ id: 1, url: "chrome://extensions" }),
      fakeTab({ id: 2, url: "https://github.com/a" }),
      fakeTab({ id: 3, url: "chrome-extension://abc/popup.html" }),
    ]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tabId).toBe(2);
  });

  it("omits an empty title rather than sending an empty string", () => {
    const { tabs } = buildImportPayload([fakeTab({ title: "" })]);
    expect(tabs[0].title).toBeUndefined();
  });

  it("carries pinned/active state through", () => {
    const { tabs } = buildImportPayload([fakeTab({ pinned: true, active: true })]);
    expect(tabs[0].pinned).toBe(true);
    expect(tabs[0].active).toBe(true);
  });

  it("skips tabs with no url at all", () => {
    const { tabs } = buildImportPayload([fakeTab({ url: undefined }), fakeTab({ id: 2 })]);
    expect(tabs).toHaveLength(1);
  });

  it("returns an empty payload for an empty tab set", () => {
    expect(buildImportPayload([])).toEqual({ tabs: [] });
  });

  it("handles undefined/null input defensively", () => {
    expect(buildImportPayload(undefined)).toEqual({ tabs: [] });
    expect(buildImportPayload(null)).toEqual({ tabs: [] });
  });

  it("handles a large batch (200 tabs) correctly and quickly", () => {
    const chromeTabs = Array.from({ length: 200 }, (_, i) =>
      fakeTab({ id: i, url: `https://example.com/page-${i}`, title: `Page ${i}` })
    );
    const start = performance.now();
    const { tabs } = buildImportPayload(chromeTabs);
    const elapsed = performance.now() - start;
    expect(tabs).toHaveLength(200);
    expect(tabs[199].title).toBe("Page 199");
    expect(elapsed).toBeLessThan(200);
  });

  it("drops tabs whose exact url is in excludeUrls", () => {
    const { tabs } = buildImportPayload(
      [
        fakeTab({ id: 1, url: "https://a.example" }),
        fakeTab({ id: 2, url: "https://b.example" }),
        fakeTab({ id: 3, url: "https://c.example" }),
      ],
      ["https://b.example"]
    );
    expect(tabs.map((t) => t.tabId)).toEqual([1, 3]);
  });

  it("ignores excludeUrls when omitted, keeping current no-filter behavior", () => {
    const { tabs } = buildImportPayload([fakeTab({ url: "https://a.example" })]);
    expect(tabs).toHaveLength(1);
  });

  it("excludes every tab when excludeUrls covers the whole batch", () => {
    const { tabs } = buildImportPayload(
      [fakeTab({ url: "https://a.example" }), fakeTab({ url: "https://b.example" })],
      ["https://a.example", "https://b.example"]
    );
    expect(tabs).toHaveLength(0);
  });

  it("excludes privileged tabs even within a large mixed batch", () => {
    const chromeTabs = [
      ...Array.from({ length: 50 }, (_, i) => fakeTab({ id: i, url: `https://example.com/${i}` })),
      fakeTab({ id: 999, url: "chrome://settings" }),
      fakeTab({ id: 998, url: "devtools://devtools/bundled/x.html" }),
    ];
    const { tabs } = buildImportPayload(chromeTabs);
    expect(tabs).toHaveLength(50);
  });
});
