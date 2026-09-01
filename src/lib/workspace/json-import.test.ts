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
