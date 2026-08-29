import { describe, expect, it } from "vitest";
import { buildWorkspaceExport, serializeWorkspaceExport, EXPORT_VERSION } from "./json-export";
import type { Workspace } from "./types";

function makeWorkspace(id: string): Workspace {
  return {
    id,
    name: "General",
    tabs: [{ id: "t1", url: "https://example.com", normalizedUrl: "https://example.com", domain: "example.com" }],
    createdAt: 1000,
    updatedAt: 2000,
  };
}

describe("buildWorkspaceExport", () => {
  it("stamps the current version and an ISO timestamp", () => {
    const data = buildWorkspaceExport([makeWorkspace("a")]);
    expect(data.version).toBe(EXPORT_VERSION);
    expect(() => new Date(data.exportedAt).toISOString()).not.toThrow();
  });

  it("carries the given workspaces through verbatim", () => {
    const workspaces = [makeWorkspace("a"), makeWorkspace("b")];
    const data = buildWorkspaceExport(workspaces);
    expect(data.workspaces).toEqual(workspaces);
  });

  it("supports exporting a single workspace or all of them", () => {
    expect(buildWorkspaceExport([makeWorkspace("a")]).workspaces).toHaveLength(1);
    expect(buildWorkspaceExport([makeWorkspace("a"), makeWorkspace("b")]).workspaces).toHaveLength(2);
  });

  it("defaults to an empty dependencies array when none are given", () => {
    expect(buildWorkspaceExport([makeWorkspace("a")]).dependencies).toEqual([]);
  });

  it("includes a dependency whose tabs are both in the exported workspaces", () => {
    const dep = { id: "d1", parentTabId: "t1", childTabId: "t1-other", createdAt: 1 };
    const workspace = { ...makeWorkspace("a"), tabs: [...makeWorkspace("a").tabs, { id: "t1-other", url: "https://x.example", normalizedUrl: "https://x.example", domain: "x.example" }] };
    const data = buildWorkspaceExport([workspace], [dep]);
    expect(data.dependencies).toEqual([dep]);
  });

  it("drops a dependency whose tab isn't in any exported workspace", () => {
    const dep = { id: "d1", parentTabId: "t1", childTabId: "not-exported", createdAt: 1 };
    const data = buildWorkspaceExport([makeWorkspace("a")], [dep]);
    expect(data.dependencies).toEqual([]);
  });

  it("defaults to an empty collections array when none are given", () => {
    expect(buildWorkspaceExport([makeWorkspace("a")]).collections).toEqual([]);
  });

  it("includes a collection whose workspace is exported", () => {
    const collection = { id: "c1", workspaceId: "a", name: "Physics IA", tabIds: ["t1"], createdAt: 1, updatedAt: 1 };
    const data = buildWorkspaceExport([makeWorkspace("a")], [], [collection]);
    expect(data.collections).toEqual([collection]);
  });

  it("drops a collection whose workspace isn't exported", () => {
    const collection = { id: "c1", workspaceId: "not-exported", name: "Orphan", tabIds: [], createdAt: 1, updatedAt: 1 };
    const data = buildWorkspaceExport([makeWorkspace("a")], [], [collection]);
    expect(data.collections).toEqual([]);
  });

  it("prunes a collection's tab ids down to tabs actually in the exported workspace", () => {
    const collection = { id: "c1", workspaceId: "a", name: "Physics IA", tabIds: ["t1", "stale"], createdAt: 1, updatedAt: 1 };
    const data = buildWorkspaceExport([makeWorkspace("a")], [], [collection]);
    expect(data.collections[0].tabIds).toEqual(["t1"]);
  });
});

describe("serializeWorkspaceExport", () => {
  it("produces valid, round-trippable JSON", () => {
    const data = buildWorkspaceExport([makeWorkspace("a")]);
    const text = serializeWorkspaceExport(data);
    expect(JSON.parse(text)).toEqual(data);
  });
});
