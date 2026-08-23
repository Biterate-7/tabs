import { describe, expect, it } from "vitest";
import { findDuplicatesAction } from "./duplicates";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { BrowserContextSnapshot } from "@/lib/browser/protocol";

function makeTab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com", ...over };
}

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return { name: "Untitled", tabs: [], createdAt: 0, updatedAt: 0, ...over };
}

function makeStore(workspaces: Workspace[], currentId: string): WorkspaceStore {
  return { version: 1, currentId, workspaces };
}

describe("findDuplicatesAction", () => {
  it("finds no duplicates when every saved tab has a unique url", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1"), makeTab("2")] })], "a");
    const result = findDuplicatesAction.run(store, { scope: "all" }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tabdump.groupCount).toBe(0);
    expect(result.data.browser).toBeNull();
  });

  it("finds exact-url duplicates across workspaces at high confidence", () => {
    const dupeUrl = { url: "https://x.com/page", normalizedUrl: "https://x.com/page", domain: "x.com" };
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [{ id: "1", ...dupeUrl }] }),
        makeWorkspace({ id: "b", tabs: [{ id: "2", ...dupeUrl }] }),
      ],
      "a"
    );
    const result = findDuplicatesAction.run(store, { scope: "all" }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tabdump.groupCount).toBe(1);
    expect(result.data.tabdump.groups[0].confidence).toBe("high");
    expect(result.data.tabdump.groups[0].tabs.map((t) => t.tabId).sort()).toEqual(["1", "2"]);
  });

  it("scope 'current' only checks the current workspace's saved tabs", () => {
    const dupeUrl = { url: "https://x.com/page", normalizedUrl: "https://x.com/page", domain: "x.com" };
    const store = makeStore(
      [
        makeWorkspace({ id: "a", tabs: [{ id: "1", ...dupeUrl }] }),
        makeWorkspace({ id: "b", tabs: [{ id: "2", ...dupeUrl }] }),
      ],
      "a"
    );
    const result = findDuplicatesAction.run(store, { scope: "current" }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tabdump.groupCount).toBe(0);
  });

  it("finds duplicate browser tabs when the extension is connected", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const browserContext: BrowserContextSnapshot = {
      tabs: [
        { tabId: 1, windowId: 1, url: "https://a.com/x", title: "A", pinned: false, active: true, index: 0 },
        { tabId: 2, windowId: 1, url: "https://a.com/x", title: "A copy", pinned: false, active: false, index: 1 },
        { tabId: 3, windowId: 1, url: "https://b.com/y", title: "B", pinned: false, active: false, index: 2 },
      ],
      windows: [],
      activeTabId: 1,
    };
    const result = findDuplicatesAction.run(store, { scope: "all" }, { browserContext });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.browser).not.toBeNull();
    expect(result.data.browser!.groupCount).toBe(1);
    expect(result.data.browser!.groups[0].tabIds.sort()).toEqual([1, 2]);
    expect(result.data.browser!.groups[0].confidence).toBe("high");
  });

  it("does not treat different-url browser tabs as duplicates", () => {
    const store = makeStore([makeWorkspace({ id: "a" })], "a");
    const browserContext: BrowserContextSnapshot = {
      tabs: [
        { tabId: 1, windowId: 1, url: "https://a.com/x", title: "A", pinned: false, active: true, index: 0 },
        { tabId: 2, windowId: 1, url: "https://b.com/y", title: "B", pinned: false, active: false, index: 1 },
      ],
      windows: [],
      activeTabId: 1,
    };
    const result = findDuplicatesAction.run(store, { scope: "all" }, { browserContext });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.browser!.groupCount).toBe(0);
  });

  it("validate defaults scope to 'all' for anything other than 'current'", () => {
    expect(findDuplicatesAction.validate({})).toEqual({ ok: true, args: { scope: "all" } });
    expect(findDuplicatesAction.validate({ scope: "current" })).toEqual({ ok: true, args: { scope: "current" } });
    expect(findDuplicatesAction.validate({ scope: "bogus" })).toEqual({ ok: true, args: { scope: "all" } });
  });

  it("never mutates the store — read-only", () => {
    const store = makeStore([makeWorkspace({ id: "a", tabs: [makeTab("1")] })], "a");
    const result = findDuplicatesAction.run(store, { scope: "all" }, {});
    expect(result.ok && "store" in result).toBe(false);
  });
});
