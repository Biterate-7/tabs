import { describe, expect, it } from "vitest";
import { describeAddress, itemsFromBrowserTabs, itemsFromSubject, MAX_SMART_ITEMS, normalWindowIds } from "./items";
import type { BrowserTabInfo } from "@/lib/browser/protocol";
import type { Workspace } from "@/lib/workspace/types";

function tab(tabId: number, url: string, title = ""): BrowserTabInfo {
  return { tabId, windowId: 1, url, title, pinned: false, active: false, index: tabId };
}

const physics: Workspace = {
  id: "physics",
  name: "Physics",
  tabs: [
    { id: "s1", url: "https://www.example.com/saved", normalizedUrl: "https://www.example.com/saved", domain: "example.com", resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1 } },
    { id: "p1", url: "https://plain.example/tab", normalizedUrl: "https://plain.example/tab", domain: "plain.example" },
  ],
  createdAt: 1,
  updatedAt: 1,
};

describe("describeAddress", () => {
  it("accepts web pages and refuses everything a subject cannot hold", () => {
    expect(describeAddress("https://www.Example.com/a/?utm_source=x#frag")).toMatchObject({ domain: "example.com", normalizedUrl: "https://www.example.com/a" });
    for (const bad of ["chrome://newtab/", "file:///C:/notes.pdf", "javascript:alert(1)", "about:blank", "http://localhost:3000/", "not a url", ""]) {
      expect(describeAddress(bad)).toBeNull();
    }
  });
});

describe("itemsFromBrowserTabs", () => {
  it("keeps web pages only, never Hubble itself, each Chrome tab once", () => {
    const { items, skipped } = itemsFromBrowserTabs(
      [
        tab(1, "https://a.example/x", "A"),
        tab(1, "https://a.example/x", "A again (same Chrome tab id)"),
        tab(2, "chrome://extensions/", "Extensions"),
        tab(3, "https://hubble-hq.vercel.app/", "Hubble"),
        tab(4, "https://b.example/y", "https://b.example/y"),
      ],
      [],
      { selfOrigin: "https://hubble-hq.vercel.app" }
    );
    expect(items.map((entry) => [entry.id, entry.title])).toEqual([
      ["chrome-1", "A"],
      // Chrome shows the address as the title of a page without one; that is not a title.
      ["chrome-4", ""],
    ]);
    expect(skipped).toBe(2);
  });

  it("marks pages already saved — as a source or a plain tab — so they are not saved a second time", () => {
    const { items } = itemsFromBrowserTabs([tab(1, "http://example.com/saved/"), tab(2, "https://plain.example/tab"), tab(3, "https://new.example/")], [physics]);
    expect(items.map((entry) => entry.savedIn)).toEqual([{ workspaceId: "physics", name: "Physics" }, { workspaceId: "physics", name: "Physics" }, undefined]);
  });

  it("never looks at tabs in private windows — or in a window it was not told about", () => {
    const tabs = [tab(1, "https://a.example/"), { ...tab(2, "https://b.example/"), windowId: 9 }, { ...tab(3, "https://c.example/"), windowId: 42 }];
    const { items, privateSkipped } = itemsFromBrowserTabs(tabs, [], {
      normalWindowIds: normalWindowIds([
        { windowId: 1, incognito: false },
        { windowId: 9, incognito: true },
      ]),
    });
    // Window 42 opened between Chrome's two answers: unknown counts as private.
    expect(items.map((entry) => entry.url)).toEqual(["https://a.example/"]);
    expect(privateSkipped).toBe(2);
  });

  it("caps a huge tab set and reports how many were left out", () => {
    const many = Array.from({ length: MAX_SMART_ITEMS + 25 }, (_, index) => tab(index, `https://site.example/${index}`, `Page ${index}`));
    const { items, truncated } = itemsFromBrowserTabs(many, []);
    expect(items).toHaveLength(MAX_SMART_ITEMS);
    expect(truncated).toBe(25);
  });
});

describe("itemsFromSubject", () => {
  it("describes the subject's tabs and marks those already in one of its collections", () => {
    const { items } = itemsFromSubject(physics, [
      { id: "c1", workspaceId: "physics", name: "Waves", tabIds: ["p1"], createdAt: 1, updatedAt: 1 },
      { id: "c2", workspaceId: "other", name: "Elsewhere", tabIds: ["s1"], createdAt: 1, updatedAt: 1 },
    ]);
    expect(items.map((entry) => [entry.id, entry.inCollection?.name])).toEqual([
      ["s1", undefined],
      ["p1", "Waves"],
    ]);
  });
});
