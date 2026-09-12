import { describe, expect, it, vi, afterEach } from "vitest";
import { createId } from "./id";
import { parseUrls, parseSingleUrl } from "./tabs/parse";
import { createWorkspace, createGroup, createSectionInWorkspace } from "./workspace/store";
import { createCollection } from "./collections/relations";
import type { WorkspaceStore } from "./workspace/types";

/**
 * RFC 4122 version 4: the 13th hex digit is `4` and the 17th is one of
 * 8/9/a/b. Asserting the shape rather than the length is what makes this a
 * real check — `"tab-1789193670715-1"` is also a 19+ character string.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a v4 UUID", () => {
    expect(createId()).toMatch(UUID_V4);
  });

  it("delegates to crypto.randomUUID", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID });

    expect(createId()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("carries no timestamp and no incrementing counter", () => {
    // The old format was `<prefix>-<epoch_ms>-<counter>`; a UUID must not
    // encode either, or two devices can still line up.
    const now = String(Date.now()).slice(0, 8);
    const ids = Array.from({ length: 50 }, () => createId());
    for (const id of ids) expect(id).not.toContain(now);
    expect(ids.some((id) => /-\d{13}-/.test(id))).toBe(false);
  });

  it("generates 10,000 unique ids", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => createId()));
    expect(ids.size).toBe(10_000);
  });

});

describe("every persistent entity type mints through the one generator", () => {
  /**
   * Driven through the real factories rather than calling createId() five
   * times, so this fails if anyone reintroduces a per-entity generator — the
   * exact defect parse.ts had. Ids used to be namespaced by their prefix
   * (`tab-`, `workspace-`); uniqueness now has to come from the UUID itself.
   */
  it("produces UUIDs with no collisions across workspaces, groups, sections, collections and tabs", () => {
    const ids = new Set<string>();
    let store = createWorkspace(
      { version: 1, currentId: "seed", workspaces: [] } as unknown as WorkspaceStore,
      "First"
    );

    for (let i = 0; i < 200; i++) {
      store = createWorkspace(store, `Workspace ${i}`);
      const workspace = store.workspaces[store.workspaces.length - 1];
      ids.add(workspace.id);

      const grouped = createGroup(store, workspace.id, `Group ${i}`);
      store = grouped.store;
      ids.add(grouped.group.id);

      const sectioned = createSectionInWorkspace(store, workspace.id, null, `Section ${i}`, "user");
      expect(sectioned).not.toBeNull();
      store = sectioned!.store;
      ids.add(sectioned!.section.id);

      const { collection } = createCollection([], workspace.id, `Collection ${i}`);
      ids.add(collection.id);

      const tab = parseSingleUrl(`https://example.com/page-${i}`);
      if (tab) ids.add(tab.id);
    }

    // 200 iterations × 5 entity types, every one distinct.
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe("createId across independent module initialisations", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("does not restart a sequence when the module is re-evaluated", async () => {
    // This is the exact failure the old generator had: `let counter = 0` at
    // module scope meant every fresh page load began at `-1` again, so two
    // devices loading in the same millisecond minted identical ids.
    vi.resetModules();
    const first = (await import("./id")).createId();
    vi.resetModules();
    const second = (await import("./id")).createId();

    expect(first).not.toBe(second);
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
  });

  it("simulates two devices starting cold and produces no collision", async () => {
    const deviceIds: string[] = [];
    for (let device = 0; device < 2; device++) {
      vi.resetModules();
      const { createId: fresh } = await import("./id");
      for (let i = 0; i < 200; i++) deviceIds.push(fresh());
    }
    expect(new Set(deviceIds).size).toBe(deviceIds.length);
  });
});

describe("the parser shares the canonical generator", () => {
  it("gives parsed tabs v4 UUIDs", () => {
    const { tabs } = parseUrls("https://a.com\nhttps://b.com\nhttps://c.com");
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) expect(tab.id).toMatch(UUID_V4);
    expect(parseSingleUrl("https://d.com")?.id).toMatch(UUID_V4);
  });

  it("never collides with ids minted by createId", () => {
    // parse.ts used to keep its OWN `let counter = 0` emitting the same
    // `tab-<ms>-<n>` shape as id.ts, so the two generators could produce the
    // same string on one device, let alone across two.
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      ids.add(createId());
      const parsed = parseSingleUrl(`https://example.com/page-${i}`);
      if (parsed) ids.add(parsed.id);
    }
    expect(ids.size).toBe(1000);
  });

  it("keeps parsing behaviour identical, underscores included", () => {
    // Guards 312be64 while the id generator underneath changes.
    const url = "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events";
    const { tabs, invalidCount } = parseUrls(url);
    expect(invalidCount).toBe(0);
    expect(tabs[0].url).toBe(url);
    expect(tabs[0].normalizedUrl).toBe(url);
    expect(tabs[0].domain).toBe("developer.mozilla.org");
  });

  it("still refuses unsafe schemes", () => {
    // Guards 9af6c71 — the id change must not touch the safelist.
    expect(parseSingleUrl("javascript://example.com/%0aalert(1)")).toBeNull();
    expect(parseSingleUrl("file:///etc/passwd")).toBeNull();
  });
});
