import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { namespacedKey, setStorageNamespace } from "@/lib/storage/namespace";
import {
  CLAUDE_MAPPING_STORAGE_KEY,
  defaultMappingState,
  findWorkspaceForProject,
  loadProjectMappings,
  projectKey,
  pruneProjectMappings,
  removeProjectMapping,
  saveProjectMappings,
  setProjectMapping,
} from "./mapping";

const T0 = 1_700_000_000_000;
const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "C:\\Users\\someone\\project";

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

describe("project keys", () => {
  it("treats the same directory written differently as the same project", () => {
    expect(projectKey("C:\\Users\\x\\p")).toBe(projectKey("C:/Users/x/p"));
    expect(projectKey("C:/Users/x/p/")).toBe(projectKey("C:/Users/x/p"));
    expect(projectKey("C:/USERS/X/P")).toBe(projectKey("c:/users/x/p"));
  });

  it("keeps genuinely different directories apart", () => {
    expect(projectKey("C:/a/b")).not.toBe(projectKey("C:/a/c"));
    expect(projectKey("C:/a/b")).not.toBe(projectKey("C:/a/b2"));
  });
});

describe("mapping a project", () => {
  it("finds the workspace for a mapped project", () => {
    const state = setProjectMapping(defaultMappingState(), PROJECT, "wA", T0);

    expect(findWorkspaceForProject(state, PROJECT)).toBe("wA");
  });

  it("matches regardless of separator or case", () => {
    const state = setProjectMapping(defaultMappingState(), PROJECT, "wA", T0);

    expect(findWorkspaceForProject(state, "C:/Users/someone/project")).toBe("wA");
    expect(findWorkspaceForProject(state, "c:\\users\\someone\\project\\")).toBe("wA");
  });

  it("returns nothing for an unmapped project — never a guess", () => {
    const state = setProjectMapping(defaultMappingState(), PROJECT, "wA", T0);

    expect(findWorkspaceForProject(state, "C:\\Users\\someone\\other")).toBeUndefined();
    expect(findWorkspaceForProject(defaultMappingState(), PROJECT)).toBeUndefined();
  });

  it("keeps one workspace per project, replacing an earlier mapping", () => {
    let state = setProjectMapping(defaultMappingState(), PROJECT, "wA", T0);
    state = setProjectMapping(state, PROJECT, "wB", T0 + 1);

    expect(state.mappings).toHaveLength(1);
    expect(findWorkspaceForProject(state, PROJECT)).toBe("wB");
  });

  it("holds mappings for several projects at once", () => {
    let state = setProjectMapping(defaultMappingState(), "C:/a", "wA", T0);
    state = setProjectMapping(state, "C:/b", "wB", T0);

    expect(findWorkspaceForProject(state, "C:/a")).toBe("wA");
    expect(findWorkspaceForProject(state, "C:/b")).toBe("wB");
  });

  it("ignores blank input", () => {
    const state = defaultMappingState();

    expect(setProjectMapping(state, "   ", "wA", T0)).toBe(state);
    expect(setProjectMapping(state, PROJECT, "  ", T0)).toBe(state);
  });

  it("removes a mapping", () => {
    const state = setProjectMapping(defaultMappingState(), PROJECT, "wA", T0);

    expect(removeProjectMapping(state, PROJECT).mappings).toEqual([]);
    expect(removeProjectMapping(state, "C:/unknown")).toBe(state);
  });

  it("prunes mappings whose workspace is gone", () => {
    let state = setProjectMapping(defaultMappingState(), "C:/a", "wA", T0);
    state = setProjectMapping(state, "C:/b", "gone", T0);

    const pruned = pruneProjectMappings(state, new Set(["wA"]));
    expect(pruned.mappings.map((m) => m.workspaceId)).toEqual(["wA"]);
  });
});

describe("persistence", () => {
  it("round trips", () => {
    const state = setProjectMapping(defaultMappingState(), PROJECT, "wA", T0);
    expect(saveProjectMappings(state)).toBe(true);

    expect(loadProjectMappings()).toEqual(state);
  });

  it("degrades to empty for corrupt or foreign state", () => {
    for (const raw of ["{not json", '"a string"', JSON.stringify({ version: 9, mappings: [] })]) {
      window.localStorage.setItem(CLAUDE_MAPPING_STORAGE_KEY, raw);
      expect(loadProjectMappings()).toEqual(defaultMappingState());
    }
  });

  it("drops malformed entries and duplicates", () => {
    window.localStorage.setItem(
      CLAUDE_MAPPING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        mappings: [
          { projectPath: "C:/a", workspaceId: "wA", createdAt: T0 },
          { projectPath: "C:\\A", workspaceId: "wDuplicate", createdAt: T0 },
          { projectPath: "", workspaceId: "wB", createdAt: T0 },
          { projectPath: "C:/c", workspaceId: "", createdAt: T0 },
          null,
        ],
      })
    );

    const state = loadProjectMappings();
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].workspaceId).toBe("wA");
  });

  it("keeps each account's mappings to itself", () => {
    setStorageNamespace(ADA);
    saveProjectMappings(setProjectMapping(defaultMappingState(), PROJECT, "ada-w", T0));

    setStorageNamespace(GRACE);
    expect(loadProjectMappings().mappings).toEqual([]);

    saveProjectMappings(setProjectMapping(defaultMappingState(), PROJECT, "grace-w", T0));
    expect(findWorkspaceForProject(loadProjectMappings(), PROJECT)).toBe("grace-w");

    setStorageNamespace(ADA);
    expect(findWorkspaceForProject(loadProjectMappings(), PROJECT)).toBe("ada-w");
  });

  it("writes under the account-prefixed key, not the bare one", () => {
    setStorageNamespace(ADA);
    saveProjectMappings(setProjectMapping(defaultMappingState(), PROJECT, "wA", T0));

    expect(window.localStorage.getItem(namespacedKey(CLAUDE_MAPPING_STORAGE_KEY, ADA))).toBeTruthy();
    expect(window.localStorage.getItem(CLAUDE_MAPPING_STORAGE_KEY)).toBeNull();
  });
});
