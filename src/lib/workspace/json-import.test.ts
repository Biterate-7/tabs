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
