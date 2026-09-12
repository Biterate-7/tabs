import { describe, expect, it } from "vitest";
import { parseWorkspaceExport } from "./json-import";
import { buildWorkspaceExport, serializeWorkspaceExport } from "./json-export";
import type { Workspace } from "./types";

function makeWorkspace(over: Partial<Workspace> & { id: string }): Workspace {
  return {
    name: "General",
    tabs: [{ id: "t1", url: "https://example.com", normalizedUrl: "https://example.com", domain: "example.com" }],
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

describe("parseWorkspaceExport", () => {
  it("round-trips a valid export", () => {
    const original = [makeWorkspace({ id: "a" }), makeWorkspace({ id: "b", name: "Research" })];
    const text = serializeWorkspaceExport(buildWorkspaceExport(original));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0].name).toBe("General");
    expect(result.workspaces[1].name).toBe("Research");
    expect(result.workspaces[0].tabs).toEqual(original[0].tabs);
    expect(result.skippedWorkspaces).toBe(0);
    expect(result.skippedTabs).toBe(0);
  });

  it("rejects malformed JSON safely instead of throwing", () => {
    expect(() => parseWorkspaceExport("{not json")).not.toThrow();
    expect(parseWorkspaceExport("{not json")).toEqual({ ok: false, reason: "invalid-json" });
  });

  it("rejects a payload missing the workspaces array", () => {
    expect(parseWorkspaceExport(JSON.stringify({ version: 1 }))).toEqual({
      ok: false,
      reason: "invalid-schema",
    });
  });

  it("rejects a completely different JSON shape (e.g. an array or primitive)", () => {
    expect(parseWorkspaceExport("[]")).toEqual({ ok: false, reason: "invalid-schema" });
    expect(parseWorkspaceExport("42")).toEqual({ ok: false, reason: "invalid-schema" });
    expect(parseWorkspaceExport('"just a string"')).toEqual({ ok: false, reason: "invalid-schema" });
    expect(parseWorkspaceExport("null")).toEqual({ ok: false, reason: "invalid-schema" });
  });

  it("rejects an unsupported version", () => {
    const text = JSON.stringify({ version: 99, exportedAt: "now", workspaces: [] });
    expect(parseWorkspaceExport(text)).toEqual({ ok: false, reason: "unsupported-version" });
  });

  it("always mints fresh workspace ids, never reusing the imported ones", () => {
    const text = serializeWorkspaceExport(buildWorkspaceExport([makeWorkspace({ id: "same-id-as-existing" })]));
    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].id).not.toBe("same-id-as-existing");
  });

  it("de-duplicates tab ids that collide within the same imported workspace", () => {
    const workspace = makeWorkspace({
      id: "a",
      tabs: [
        { id: "dup", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" },
        { id: "dup", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" },
      ],
    });
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace]));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const ids = result.workspaces[0].tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    // Original URLs are preserved even though the second tab's id was regenerated.
    expect(result.workspaces[0].tabs.map((t) => t.url)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("drops individually malformed tabs but keeps the rest of the workspace", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Mixed",
          createdAt: 1,
          updatedAt: 1,
          tabs: [
            { id: "1", url: "https://good.example", normalizedUrl: "https://good.example", domain: "good.example" },
            { id: "2" }, // missing url/normalizedUrl/domain
            "not even an object",
            { id: "3", url: "https://also-good.example", normalizedUrl: "https://also-good.example", domain: "also-good.example" },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].tabs).toHaveLength(2);
    expect(result.skippedTabs).toBe(2);
  });

  it("skips a workspace entry with no tabs array at all, but keeps valid siblings", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        { id: "a", name: "Broken" }, // no tabs array
        { id: "b", name: "Fine", tabs: [], createdAt: 1, updatedAt: 1 },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].name).toBe("Fine");
    expect(result.skippedWorkspaces).toBe(1);
  });

  it("preserves an intentionally empty workspace (no tabs is valid)", () => {
    const text = serializeWorkspaceExport(buildWorkspaceExport([makeWorkspace({ id: "a", tabs: [] })]));
    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].tabs).toEqual([]);
  });

  it("falls back to a default name for a workspace missing one", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", tabs: [], createdAt: 1, updatedAt: 1 }],
    });
    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].name).toBe("Untitled");
  });

  it("round-trips a workspace's logo through export and import", () => {
    const logo = `data:image/png;base64,${"A".repeat(100)}`;
    const workspace = makeWorkspace({ id: "a", logo });
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace]));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].logo).toBe(logo);
  });

  it("imports a workspace with no logo without adding one", () => {
    const text = serializeWorkspaceExport(buildWorkspaceExport([makeWorkspace({ id: "a" })]));
    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].logo).toBeUndefined();
  });

  it("imports an old export with no `logo` field at all (pre-logo backward compatibility)", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Legacy", tabs: [], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].logo).toBeUndefined();
  });

  it("drops a malformed logo (wrong shape) rather than rejecting the whole workspace", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        { id: "a", name: "Odd", tabs: [], createdAt: 1, updatedAt: 1, logo: "not-a-data-url" },
        { id: "b", name: "Also odd", tabs: [], createdAt: 1, updatedAt: 1, logo: 12345 },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].logo).toBeUndefined();
    expect(result.workspaces[1].logo).toBeUndefined();
  });

  it("drops an oversized logo rather than rejecting the whole workspace", () => {
    const hugeLogo = `data:image/png;base64,${"A".repeat(800_000)}`;
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Huge", tabs: [], createdAt: 1, updatedAt: 1, logo: hugeLogo }],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].logo).toBeUndefined();
  });

  it("round-trips a workspace's groups through export and import", () => {
    const workspace = makeWorkspace({
      id: "a",
      groups: [
        { id: "g1", name: "Midterms", createdAt: 10, updatedAt: 20 },
        { id: "g2", name: "Labs", createdAt: 30, updatedAt: 40 },
      ],
    });
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace]));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].groups).toEqual([
      { id: "g1", name: "Midterms", createdAt: 10, updatedAt: 20 },
      { id: "g2", name: "Labs", createdAt: 30, updatedAt: 40 },
    ]);
  });

  it("imports a workspace with no groups without adding one", () => {
    const text = serializeWorkspaceExport(buildWorkspaceExport([makeWorkspace({ id: "a" })]));
    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].groups).toBeUndefined();
  });

  it("imports an old export with no `groups` field at all (pre-groups backward compatibility)", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Legacy", tabs: [], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].name).toBe("Legacy");
    expect(result.workspaces[0].groups).toBeUndefined();
  });

  it("safely drops malformed group entries while keeping valid ones and the rest of the workspace", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Mixed groups",
          tabs: [],
          createdAt: 1,
          updatedAt: 1,
          groups: [
            { id: "g1", name: "Valid", createdAt: 1, updatedAt: 1 },
            { id: "g2" }, // missing name
            { name: "" }, // blank name
            "not even an object",
            42,
            null,
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].groups).toEqual([{ id: "g1", name: "Valid", createdAt: 1, updatedAt: 1 }]);
  });

  it("treats a completely malformed `groups` field (not an array) as absent rather than rejecting the workspace", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Odd", tabs: [], createdAt: 1, updatedAt: 1, groups: "not an array" }],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].name).toBe("Odd");
    expect(result.workspaces[0].groups).toBeUndefined();
  });

  it("regenerates a group id that's missing or collides with another group in the same workspace", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Dup groups",
          tabs: [],
          createdAt: 1,
          updatedAt: 1,
          groups: [
            { id: "dup", name: "First", createdAt: 1, updatedAt: 1 },
            { id: "dup", name: "Second", createdAt: 1, updatedAt: 1 },
            { name: "No id at all" },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const groups = result.workspaces[0].groups!;
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.id)).size).toBe(3);
    expect(groups.map((g) => g.name)).toEqual(["First", "Second", "No id at all"]);
  });

  it("round-trips a tab's groupId through export and import", () => {
    const workspace = makeWorkspace({
      id: "a",
      groups: [{ id: "g1", name: "Midterms", createdAt: 10, updatedAt: 20 }],
      tabs: [
        { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", groupId: "g1" },
        { id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" },
      ],
    });
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace]));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const [t1, t2] = result.workspaces[0].tabs;
    expect(t1.groupId).toBe("g1");
    expect(t2.groupId).toBeUndefined();
  });

  it("remaps a tab's groupId when the group's id is regenerated on import due to a collision", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Dup groups",
          createdAt: 1,
          updatedAt: 1,
          groups: [
            { id: "dup", name: "First", createdAt: 1, updatedAt: 1 },
            { id: "dup", name: "Second", createdAt: 1, updatedAt: 1 },
          ],
          tabs: [
            { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", groupId: "dup" },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const groups = result.workspaces[0].groups!;
    const first = groups.find((g) => g.name === "First")!;
    // The raw export had t1.groupId reference the FIRST "dup" id (which
    // keeps it); the second "First"-named group is the one that collided
    // and got a freshly minted id instead.
    expect(result.workspaces[0].tabs[0].groupId).toBe(first.id);
  });

  it("drops a tab's groupId that doesn't reference any group in the workspace, without failing the import", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Dangling ref",
          createdAt: 1,
          updatedAt: 1,
          groups: [{ id: "g1", name: "Real group", createdAt: 1, updatedAt: 1 }],
          tabs: [
            { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", groupId: "ghost" },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].tabs).toHaveLength(1);
    expect(result.workspaces[0].tabs[0].groupId).toBeUndefined();
  });

  it("drops a tab's groupId when the workspace has no groups array at all", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "No groups",
          createdAt: 1,
          updatedAt: 1,
          tabs: [
            { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", groupId: "g1" },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].tabs[0].groupId).toBeUndefined();
  });

  it("drops a malformed (non-string) tab.groupId without failing the tab", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Malformed groupId",
          createdAt: 1,
          updatedAt: 1,
          groups: [{ id: "g1", name: "Real group", createdAt: 1, updatedAt: 1 }],
          tabs: [
            { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", groupId: 42 },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].tabs[0].groupId).toBeUndefined();
  });

  it("round-trips a dependency between two tabs in the same exported workspace", () => {
    const workspace = makeWorkspace({
      id: "a",
      tabs: [
        { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" },
        { id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" },
      ],
    });
    const dependencies = [{ id: "d1", parentTabId: "t1", childTabId: "t2", type: "research" as const, createdAt: 5 }];
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace], dependencies));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.dependencies).toHaveLength(1);
    const [t1, t2] = result.workspaces[0].tabs;
    expect(result.dependencies[0]).toMatchObject({ parentTabId: t1.id, childTabId: t2.id, type: "research" });
    expect(result.skippedDependencies).toBe(0);
  });

  it("remaps a dependency's tab ids when a tab id collision regenerates them on import", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Dup tabs",
          createdAt: 1,
          updatedAt: 1,
          tabs: [
            { id: "dup", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" },
            { id: "dup", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" },
          ],
        },
      ],
      dependencies: [{ id: "d1", parentTabId: "dup", childTabId: "dup", createdAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // The raw dependency named "dup" -> "dup", which the tab id map resolves
    // to the FIRST tab that claimed that raw id — since both endpoints
    // resolve to the same final tab, this is a self-dependency and must be
    // dropped rather than silently kept.
    expect(result.dependencies).toEqual([]);
    expect(result.skippedDependencies).toBe(1);
  });

  it("ignores a dependency referencing a tab id that doesn't exist in the import, without failing", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "A", createdAt: 1, updatedAt: 1, tabs: [{ id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" }] }],
      dependencies: [{ id: "d1", parentTabId: "t1", childTabId: "ghost", createdAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.dependencies).toEqual([]);
    expect(result.skippedDependencies).toBe(1);
  });

  it("drops a self-dependency in the import file", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "A", createdAt: 1, updatedAt: 1, tabs: [{ id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" }] }],
      dependencies: [{ id: "d1", parentTabId: "t1", childTabId: "t1", createdAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.dependencies).toEqual([]);
  });

  it("de-duplicates repeated dependency entries within the same import file", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "A",
          createdAt: 1,
          updatedAt: 1,
          tabs: [
            { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" },
            { id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" },
          ],
        },
      ],
      dependencies: [
        { id: "d1", parentTabId: "t1", childTabId: "t2", createdAt: 1 },
        { id: "d2", parentTabId: "t1", childTabId: "t2", createdAt: 2 },
      ],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.dependencies).toHaveLength(1);
  });

  it("imports an export with no `dependencies` field at all (pre-dependencies backward compatibility)", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Legacy", tabs: [], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.dependencies).toEqual([]);
    expect(result.skippedDependencies).toBe(0);
  });

  it("handles duplicate workspace ids across the imported payload without crashing", () => {
    const text = serializeWorkspaceExport(
      buildWorkspaceExport([makeWorkspace({ id: "dup" }), makeWorkspace({ id: "dup", name: "Second" })])
    );

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces).toHaveLength(2);
    expect(new Set(result.workspaces.map((w) => w.id)).size).toBe(2);
  });
});

describe("parseWorkspaceExport sections", () => {
  it("round-trips a nested section tree and each tab's sectionId", () => {
    const workspace = makeWorkspace({
      id: "a",
      sections: [
        { id: "root", parentId: null, name: "School", source: "ai", createdAt: 1, updatedAt: 1 },
        { id: "sub", parentId: "root", name: "Physics", source: "ai", createdAt: 2, updatedAt: 2 },
      ],
      tabs: [{ id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", sectionId: "sub" }],
    });
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace]));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const sections = result.workspaces[0].sections!;
    expect(sections.map((s) => s.name).sort()).toEqual(["Physics", "School"]);
    const root = sections.find((s) => s.name === "School")!;
    const sub = sections.find((s) => s.name === "Physics")!;
    expect(sub.parentId).toBe(root.id);
    expect(result.workspaces[0].tabs[0].sectionId).toBe(sub.id);
  });

  it("imports a workspace with no sections without adding one", () => {
    const text = serializeWorkspaceExport(buildWorkspaceExport([makeWorkspace({ id: "a" })]));
    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].sections).toBeUndefined();
  });

  it("imports an old export with no `sections` field at all (pre-sections backward compatibility)", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Legacy", tabs: [], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].sections).toBeUndefined();
  });

  it("promotes a section to root when its parent didn't survive sanitization, instead of dropping it", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Orphaned child",
          tabs: [],
          createdAt: 1,
          updatedAt: 1,
          sections: [{ id: "s1", parentId: "ghost-parent", name: "Physics", source: "ai", createdAt: 1, updatedAt: 1 }],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const sections = result.workspaces[0].sections!;
    expect(sections).toHaveLength(1);
    expect(sections[0].parentId).toBeNull();
  });

  it("regenerates a section id that collides with another in the same workspace and remaps parentId references accordingly", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Dup sections",
          tabs: [],
          createdAt: 1,
          updatedAt: 1,
          sections: [
            { id: "dup", parentId: null, name: "First", source: "user", createdAt: 1, updatedAt: 1 },
            { id: "dup", parentId: null, name: "Second", source: "user", createdAt: 1, updatedAt: 1 },
            { id: "child", parentId: "dup", name: "Child of first", source: "ai", createdAt: 1, updatedAt: 1 },
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const sections = result.workspaces[0].sections!;
    expect(sections).toHaveLength(3);
    expect(new Set(sections.map((s) => s.id)).size).toBe(3);
    const first = sections.find((s) => s.name === "First")!;
    const child = sections.find((s) => s.name === "Child of first")!;
    // "child"'s raw parentId "dup" resolves to whichever section actually
    // kept that raw id — the first one to claim it, same convention as
    // groups' collision handling.
    expect(child.parentId).toBe(first.id);
  });

  it("drops a malformed section entry (missing name) while keeping valid ones", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Mixed sections",
          tabs: [],
          createdAt: 1,
          updatedAt: 1,
          sections: [
            { id: "s1", parentId: null, name: "Valid", source: "user", createdAt: 1, updatedAt: 1 },
            { id: "s2" }, // missing name
            { name: "" }, // blank name
            "not even an object",
          ],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].sections).toEqual([
      { id: "s1", parentId: null, name: "Valid", source: "user", createdAt: 1, updatedAt: 1 },
    ]);
  });

  it("drops a tab's sectionId that doesn't reference any section in the workspace", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [
        {
          id: "a",
          name: "Dangling ref",
          tabs: [{ id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example", sectionId: "ghost" }],
          createdAt: 1,
          updatedAt: 1,
          sections: [{ id: "s1", parentId: null, name: "Real", source: "ai", createdAt: 1, updatedAt: 1 }],
        },
      ],
    });

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.workspaces[0].tabs[0].sectionId).toBeUndefined();
  });
});

describe("parseWorkspaceExport collections", () => {
  it("round-trips a collection, remapping its workspaceId and tabIds to the freshly-minted ones", () => {
    const workspace = makeWorkspace({
      id: "a",
      tabs: [
        { id: "t1", url: "https://a.example", normalizedUrl: "https://a.example", domain: "a.example" },
        { id: "t2", url: "https://b.example", normalizedUrl: "https://b.example", domain: "b.example" },
      ],
    });
    const collections = [
      { id: "c1", workspaceId: "a", name: "Physics IA", tabIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 },
    ];
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace], [], collections));

    const result = parseWorkspaceExport(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.collections).toHaveLength(1);
    const [t1, t2] = result.workspaces[0].tabs;
    expect(result.collections[0].name).toBe("Physics IA");
    expect(result.collections[0].workspaceId).toBe(result.workspaces[0].id);
    expect(result.collections[0].tabIds.sort()).toEqual([t1.id, t2.id].sort());
    expect(result.skippedCollections).toBe(0);
  });

  it("mints a fresh collection id rather than trusting the raw one", () => {
    const workspace = makeWorkspace({ id: "a" });
    const collections = [{ id: "same-id", workspaceId: "a", name: "One", tabIds: [], createdAt: 1, updatedAt: 1 }];
    const text = serializeWorkspaceExport(buildWorkspaceExport([workspace], [], collections));

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.collections[0].id).not.toBe("same-id");
  });

  it("drops a stale tab id from an imported collection instead of failing the entry", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Ws", tabs: [{ id: "t1", url: "https://x.example", normalizedUrl: "https://x.example", domain: "x.example" }], createdAt: 1, updatedAt: 1 }],
      collections: [{ id: "c1", workspaceId: "a", name: "Physics", tabIds: ["t1", "ghost"], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.collections[0].tabIds).toEqual([result.workspaces[0].tabs[0].id]);
  });

  it("drops a collection referencing a workspace that isn't part of this import", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Ws", tabs: [], createdAt: 1, updatedAt: 1 }],
      collections: [{ id: "c1", workspaceId: "not-in-file", name: "Orphan", tabIds: [], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.collections).toEqual([]);
    expect(result.skippedCollections).toBe(1);
  });

  it("drops a malformed collection (missing name) rather than failing the whole import", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Ws", tabs: [], createdAt: 1, updatedAt: 1 }],
      collections: [{ id: "c1", workspaceId: "a", tabIds: [] }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.collections).toEqual([]);
    expect(result.skippedCollections).toBe(1);
  });

  it("imports an export with no `collections` field at all (backward compatibility)", () => {
    const text = JSON.stringify({
      version: 1,
      exportedAt: "now",
      workspaces: [{ id: "a", name: "Legacy", tabs: [], createdAt: 1, updatedAt: 1 }],
    });

    const result = parseWorkspaceExport(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.collections).toEqual([]);
    expect(result.skippedCollections).toBe(0);
  });
});

/**
 * An export file is untrusted input: it is a plain .json someone can hand
 * you, or edit by hand before re-importing. These cover the two things that
 * a file could previously smuggle past sanitizeTabs, which validated that
 * `url`/`normalizedUrl`/`domain` were *strings* and then spread the rest of
 * the entry through verbatim.
 */
function importTabs(tabs: unknown[]) {
  return parseWorkspaceExport(
    JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: [{ id: "w1", name: "W", tabs, createdAt: 1, updatedAt: 2 }],
      dependencies: [],
      collections: [],
    })
  );
}

describe("import cannot reintroduce an unsafe URL scheme", () => {
  const UNSAFE = [
    "javascript:alert(1)",
    "javascript://example.com/%0aalert(1)",
    "JavaScript://example.com/%0aalert(1)",
    "data:text/html,<h1>x</h1>",
    "data://example.com/x",
    "file:///etc/passwd",
    "file://example.com/share",
    "vbscript://example.com/x",
    "about:blank",
    "blob:https://example.com/9b7a-1",
    "chrome://settings",
  ];

  it.each(UNSAFE)("drops a tab whose url is %s", (url) => {
    const result = importTabs([{ id: "t1", url, normalizedUrl: url, domain: "example.com" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces[0].tabs).toHaveLength(0);
    expect(result.skippedTabs).toBe(1);
  });

  it("drops a tab whose normalizedUrl is unsafe even when url looks fine", () => {
    // normalizedUrl is what dedupe compares and what several views read.
    const result = importTabs([
      {
        id: "t1",
        url: "https://example.com/ok",
        normalizedUrl: "javascript://example.com/%0aalert(1)",
        domain: "example.com",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces[0].tabs).toHaveLength(0);
    expect(result.skippedTabs).toBe(1);
  });

  it("keeps the safe tabs in a mixed file and counts the rest as skipped", () => {
    const result = importTabs([
      { id: "t1", url: "javascript://example.com/%0aalert(1)", normalizedUrl: "javascript://example.com/%0aalert(1)", domain: "example.com" },
      { id: "t2", url: "https://example.com/path_with_underscores", normalizedUrl: "https://example.com/path_with_underscores", domain: "example.com" },
      { id: "t3", url: "file:///etc/passwd", normalizedUrl: "file:///etc/passwd", domain: "" },
      { id: "t4", url: "http://example.com/a?x=1&y=2#frag_1", normalizedUrl: "http://example.com/a?x=1&y=2", domain: "example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces[0].tabs.map((t) => t.url)).toEqual([
      "https://example.com/path_with_underscores",
      "http://example.com/a?x=1&y=2#frag_1",
    ]);
    expect(result.skippedTabs).toBe(2);
  });
});

describe("import normalises wrong-typed tab fields", () => {
  // Every one of these is read somewhere as a string — `title?.trim()` alone
  // appears in a dozen render paths, and `?.` guards null, not a number. A
  // hand-edited file could therefore crash the graph and workspace views.
  it.each(["title", "category", "favicon", "notes", "organizationReason"])(
    "drops a non-string %s rather than storing it",
    (field) => {
      const result = importTabs([
        {
          id: "t1",
          url: "https://example.com",
          normalizedUrl: "https://example.com",
          domain: "example.com",
          [field]: 12345,
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const tab = result.workspaces[0].tabs[0] as unknown as Record<string, unknown>;
      expect(tab[field]).toBeUndefined();
    }
  );

  it("survives the exact expression the graph renders with", () => {
    const result = importTabs([
      { id: "t1", url: "https://example.com", normalizedUrl: "https://example.com", domain: "example.com", title: 12345 },
      { id: "t2", url: "https://example.org", normalizedUrl: "https://example.org", domain: "example.org", title: { evil: true } },
      { id: "t3", url: "https://example.net", normalizedUrl: "https://example.net", domain: "example.net", title: ["a"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const tab of result.workspaces[0].tabs) {
      // graph-canvas.tsx:1116 and ~12 other sites do exactly this.
      expect(() => tab.title?.trim() || tab.domain).not.toThrow();
    }
  });

  it("keeps well-typed optional fields untouched", () => {
    const result = importTabs([
      {
        id: "t1",
        url: "https://example.com",
        normalizedUrl: "https://example.com",
        domain: "example.com",
        title: "  Real Title  ",
        category: "research",
        notes: "a note",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tab = result.workspaces[0].tabs[0];
    expect(tab.title).toBe("  Real Title  ");
    expect(tab.category).toBe("research");
    expect(tab.notes).toBe("a note");
  });
});

describe("import cannot pollute Object.prototype", () => {
  it("leaves the prototype clean for __proto__/constructor/prototype keys", () => {
    const before = Object.keys(Object.prototype).length;
    parseWorkspaceExport(
      '{"version":1,"workspaces":[{"id":"w","name":"W","tabs":[' +
        '{"id":"t1","url":"https://a.com","normalizedUrl":"https://a.com","domain":"a.com","__proto__":{"polluted":"yes"}},' +
        '{"id":"t2","url":"https://b.com","normalizedUrl":"https://b.com","domain":"b.com","constructor":{"polluted":"yes"}}' +
        '],"createdAt":1,"updatedAt":2}],"dependencies":[],"collections":[]}'
    );
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(Object.prototype).length).toBe(before);
  });
});

/**
 * Id generation moved to crypto.randomUUID(). The import contract is
 * unchanged — ids that arrive intact are preserved, ids that are missing or
 * collide are re-minted, and every reference is remapped — but the re-minted
 * ones are now UUIDs. These pin both halves: old ids keep working, new ones
 * are globally unique.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("id minting during import", () => {
  it("preserves a legacy timestamp-counter id that arrives intact", () => {
    // Phase 6 compatibility: nothing is rewritten just for being old.
    const result = importTabs([
      {
        id: "tab-1789193670715-1",
        url: "https://example.com/a",
        normalizedUrl: "https://example.com/a",
        domain: "example.com",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces[0].tabs[0].id).toBe("tab-1789193670715-1");
  });

  it("mints a UUID when a tab id is missing", () => {
    const result = importTabs([
      { url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces[0].tabs[0].id).toMatch(UUID_V4);
  });

  it("mints a UUID for the loser of an id collision, keeping the first", () => {
    const result = importTabs([
      { id: "dup", url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com" },
      { id: "dup", url: "https://example.com/b", normalizedUrl: "https://example.com/b", domain: "example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.workspaces[0].tabs;
    expect(first.id).toBe("dup");
    expect(second.id).toMatch(UUID_V4);
    expect(first.id).not.toBe(second.id);
  });

  it("always mints a fresh UUID workspace id, so an import cannot overwrite", () => {
    const result = importTabs([
      { id: "t", url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces[0].id).toMatch(UUID_V4);
    expect(result.workspaces[0].id).not.toBe("w1");
  });

  it("remaps every reference when ids are re-minted", () => {
    // A collision forces a new id for the second tab; the dependency and the
    // collection that point at it must follow it to its new id.
    const raw = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: [
        {
          id: "w1",
          name: "W",
          createdAt: 1,
          updatedAt: 2,
          groups: [{ id: "g1", name: "Group", createdAt: 1, updatedAt: 2 }],
          sections: [{ id: "s1", parentId: null, name: "Sec", source: "user", createdAt: 1, updatedAt: 2 }],
          tabs: [
            {
              id: "shared",
              url: "https://example.com/a",
              normalizedUrl: "https://example.com/a",
              domain: "example.com",
              groupId: "g1",
              sectionId: "s1",
            },
            {
              id: "shared",
              url: "https://example.com/b",
              normalizedUrl: "https://example.com/b",
              domain: "example.com",
            },
          ],
        },
      ],
      dependencies: [{ id: "d1", parentTabId: "shared", childTabId: "shared", createdAt: 1 }],
      collections: [{ id: "c1", workspaceId: "w1", name: "Coll", tabIds: ["shared"], createdAt: 1, updatedAt: 2 }],
    });

    const result = parseWorkspaceExport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const workspace = result.workspaces[0];
    const [kept, reminted] = workspace.tabs;
    expect(kept.id).toBe("shared");
    expect(reminted.id).toMatch(UUID_V4);

    // group/section references survive and still point at real rows
    expect(kept.groupId).toBe("g1");
    expect(kept.sectionId).toBe("s1");
    expect(workspace.groups?.[0].id).toBe("g1");
    expect(workspace.sections?.[0].id).toBe("s1");

    // the collection's workspaceId followed the freshly minted workspace id
    expect(result.collections[0].workspaceId).toBe(workspace.id);
    expect(result.collections[0].id).toMatch(UUID_V4);
    expect(result.collections[0].tabIds).toEqual(["shared"]);

    // a self-referencing dependency is still dropped, exactly as before
    expect(result.dependencies).toHaveLength(0);
    expect(result.skippedDependencies).toBe(1);
  });

  it("keeps a dependency pointing at the right tabs after a re-mint", () => {
    const raw = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: [
        {
          id: "w1",
          name: "W",
          createdAt: 1,
          updatedAt: 2,
          tabs: [
            { id: "p", url: "https://example.com/p", normalizedUrl: "https://example.com/p", domain: "example.com" },
            { id: "c", url: "https://example.com/c", normalizedUrl: "https://example.com/c", domain: "example.com" },
          ],
        },
      ],
      dependencies: [{ id: "d1", parentTabId: "p", childTabId: "c", createdAt: 1 }],
      collections: [],
    });

    const result = parseWorkspaceExport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0].parentTabId).toBe("p");
    expect(result.dependencies[0].childTabId).toBe("c");
  });
});

/**
 * Timestamps are the sync metadata a later phase compares, so an export must
 * carry them through untouched. The rule at this boundary: a file that
 * already states a valid timestamp keeps it; only a missing or malformed one
 * falls back to the import's own clock.
 */
describe("timestamps survive import", () => {
  const T_CREATED = 1_600_000_000_000;
  const T_UPDATED = 1_700_000_000_000;

  it("preserves valid tab timestamps exactly", () => {
    const result = importTabs([
      {
        id: "t1",
        url: "https://example.com/a",
        normalizedUrl: "https://example.com/a",
        domain: "example.com",
        createdAt: T_CREATED,
        updatedAt: T_UPDATED,
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tab = result.workspaces[0].tabs[0];
    expect(tab.createdAt).toBe(T_CREATED);
    expect(tab.updatedAt).toBe(T_UPDATED);
  });

  it("imports a legacy tab with no timestamps without inventing any", () => {
    const result = importTabs([
      { id: "t1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tab = result.workspaces[0].tabs[0];
    expect(tab.createdAt).toBeUndefined();
    expect(tab.updatedAt).toBeUndefined();
    expect(tab.url).toBe("https://example.com/a");
  });

  it.each([NaN, Infinity, "yesterday", null, {}, [], true])(
    "drops a malformed tab timestamp of %s rather than failing the import",
    (bad) => {
      const result = importTabs([
        {
          id: "t1",
          url: "https://example.com/a",
          normalizedUrl: "https://example.com/a",
          domain: "example.com",
          createdAt: bad,
          updatedAt: bad,
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workspaces[0].tabs).toHaveLength(1);
      expect(result.workspaces[0].tabs[0].createdAt).toBeUndefined();
      expect(result.workspaces[0].tabs[0].updatedAt).toBeUndefined();
    }
  );

  it("preserves workspace, group and section timestamps", () => {
    const raw = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: [
        {
          id: "w1",
          name: "W",
          createdAt: T_CREATED,
          updatedAt: T_UPDATED,
          groups: [{ id: "g1", name: "G", createdAt: T_CREATED, updatedAt: T_UPDATED }],
          sections: [
            { id: "s1", parentId: null, name: "S", source: "user", createdAt: T_CREATED, updatedAt: T_UPDATED },
          ],
          tabs: [
            { id: "t1", url: "https://example.com/a", normalizedUrl: "https://example.com/a", domain: "example.com" },
          ],
        },
      ],
      dependencies: [],
      collections: [],
    });

    const result = parseWorkspaceExport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.workspaces[0];
    expect(w.createdAt).toBe(T_CREATED);
    expect(w.updatedAt).toBe(T_UPDATED);
    expect(w.groups?.[0].createdAt).toBe(T_CREATED);
    expect(w.groups?.[0].updatedAt).toBe(T_UPDATED);
    expect(w.sections?.[0].createdAt).toBe(T_CREATED);
    expect(w.sections?.[0].updatedAt).toBe(T_UPDATED);
  });

  it("preserves dependency and collection timestamps", () => {
    const raw = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaces: [
        {
          id: "w1",
          name: "W",
          createdAt: 1,
          updatedAt: 2,
          tabs: [
            { id: "p", url: "https://example.com/p", normalizedUrl: "https://example.com/p", domain: "example.com" },
            { id: "c", url: "https://example.com/c", normalizedUrl: "https://example.com/c", domain: "example.com" },
          ],
        },
      ],
      dependencies: [
        { id: "d1", parentTabId: "p", childTabId: "c", createdAt: T_CREATED, updatedAt: T_UPDATED },
      ],
      collections: [
        { id: "c1", workspaceId: "w1", name: "Coll", tabIds: ["p"], createdAt: T_CREATED, updatedAt: T_UPDATED },
      ],
    });

    const result = parseWorkspaceExport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dependencies[0].createdAt).toBe(T_CREATED);
    expect(result.dependencies[0].updatedAt).toBe(T_UPDATED);
    expect(result.collections[0].createdAt).toBe(T_CREATED);
    expect(result.collections[0].updatedAt).toBe(T_UPDATED);
  });

  it("round-trips create → export → import with timestamps and references intact", () => {
    const exported = serializeWorkspaceExport(
      buildWorkspaceExport(
        [
          {
            id: "w1",
            name: "Round",
            createdAt: T_CREATED,
            updatedAt: T_UPDATED,
            sections: [
              { id: "s1", parentId: null, name: "S", source: "user", createdAt: T_CREATED, updatedAt: T_UPDATED },
            ],
            tabs: [
              {
                id: "t1",
                url: "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events",
                normalizedUrl: "https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events",
                domain: "developer.mozilla.org",
                sectionId: "s1",
                createdAt: T_CREATED,
                updatedAt: T_UPDATED,
              },
            ],
          },
        ],
        [],
        []
      )
    );

    const result = parseWorkspaceExport(exported);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.workspaces[0];
    const t = w.tabs[0];

    expect(t.id).toBe("t1");
    expect(t.url).toBe("https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events");
    expect(t.createdAt).toBe(T_CREATED);
    expect(t.updatedAt).toBe(T_UPDATED);
    expect(t.sectionId).toBe("s1");
    expect(w.sections?.some((s) => s.id === t.sectionId)).toBe(true);
    expect(w.createdAt).toBe(T_CREATED);
    expect(w.updatedAt).toBe(T_UPDATED);
  });
});
