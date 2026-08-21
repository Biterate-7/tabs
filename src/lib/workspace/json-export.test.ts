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
});

describe("serializeWorkspaceExport", () => {
  it("produces valid, round-trippable JSON", () => {
    const data = buildWorkspaceExport([makeWorkspace("a")]);
    const text = serializeWorkspaceExport(data);
    expect(JSON.parse(text)).toEqual(data);
  });
});
