import { describe, expect, it } from "vitest";
import { applyChanges } from "@/lib/sync/apply";
import { loadWorkspaceStore, saveWorkspaceStore } from "./persistence";
import type { SyncChange } from "@/lib/sync/types";
import { buildSessionContextSnapshot, readSessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import { summarizeWorkspace } from "@/lib/agents/session-context/insight";
import {
  BRIEF_LIMITS,
  briefCountsLine,
  describeWorkspaceBrief,
  isEmptyBrief,
  readBriefText,
  readWorkspaceBrief,
  setWorkspaceBrief,
} from "./brief";
import type { Collection } from "@/lib/collections/types";
import type { Workspace, WorkspaceStore } from "./types";

const T0 = 1_700_000_000_000;

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    name: "Research",
    tabs: [
      { id: "t1", url: "https://a.example/1", normalizedUrl: "https://a.example/1", domain: "a.example", title: "One" },
      { id: "t2", url: "https://a.example/2", normalizedUrl: "https://a.example/2", domain: "a.example", title: "Two" },
      { id: "t3", url: "https://b.example/3", normalizedUrl: "https://b.example/3", domain: "b.example", title: "Three" },
    ],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const store = (...workspaces: Workspace[]): WorkspaceStore => ({ version: 1, currentId: workspaces[0]!.id, workspaces });

const collection = (id: string, name: string, tabIds: string[], workspaceId = "w1"): Collection => ({
  id,
  workspaceId,
  name,
  tabIds,
  createdAt: T0,
  updatedAt: T0,
});

describe("brief text", () => {
  it("is one line, bounded, with control characters gone", () => {
    expect(readBriefText("  Research\n and\torganize \u0007sources  ", 100)).toBe("Research and organize sources");
    expect(readBriefText("x".repeat(400), BRIEF_LIMITS.description)).toHaveLength(BRIEF_LIMITS.description);
    expect(readBriefText("   ", 100)).toBeUndefined();
    expect(readBriefText(42, 100)).toBeUndefined();
  });

  it("never keeps anything shaped like a credential", () => {
    const text = readBriefText("Deploy with api_key=abcd1234efgh and sk-ant-abcdefghijklmnopqrstuvwxyz", 280)!;
    expect(text).not.toContain("abcd1234efgh");
    expect(text).not.toContain("sk-ant-");
    expect(text).toContain("[redacted]");
  });

  it("reads a stored brief field by field, and drops one with nothing usable", () => {
    expect(readWorkspaceBrief({ description: "Purpose", focus: 7, updatedAt: 5 })).toEqual({ description: "Purpose", updatedAt: 5 });
    expect(readWorkspaceBrief({ description: " ", focus: "" })).toBeUndefined();
    expect(readWorkspaceBrief("Purpose")).toBeUndefined();
    expect(readWorkspaceBrief({ focus: "Now", updatedAt: -1 })).toEqual({ focus: "Now", updatedAt: 0 });
  });
});

describe("editing a brief", () => {
  it("sets, changes and clears it — leaving the workspace's own time and every other workspace alone", () => {
    const other = workspace({ id: "w2", name: "Other" });
    const before = store(workspace(), other);
    const set = setWorkspaceBrief(before, "w1", { description: "Climate policy sources", focus: "Carbon pricing" }, T0 + 5);
    expect(set.workspaces[0]!.brief).toEqual({ description: "Climate policy sources", focus: "Carbon pricing", updatedAt: T0 + 5 });
    expect(set.workspaces[0]!.updatedAt).toBe(T0);
    expect(set.workspaces[1]).toBe(other);

    // The same text is no change at all: the same store comes back.
    expect(setWorkspaceBrief(set, "w1", { description: "Climate policy sources ", focus: " Carbon pricing" }, T0 + 9)).toBe(set);

    const cleared = setWorkspaceBrief(set, "w1", { description: "", focus: "  " }, T0 + 10);
    expect("brief" in cleared.workspaces[0]!).toBe(false);
    expect(isEmptyBrief(cleared.workspaces[0]!.brief)).toBe(true);
  });

  it("does nothing for a workspace that does not exist", () => {
    const before = store(workspace());
    expect(setWorkspaceBrief(before, "gone", { description: "x" })).toBe(before);
  });
});

describe("the brief view", () => {
  it("describes an empty workspace honestly", () => {
    const view = describeWorkspaceBrief({ workspace: workspace({ tabs: [] }), collections: [] });
    expect(view).toEqual({ workspaceId: "w1", name: "Research", tabs: 0, collections: 0, recentChanges: 0, importantCollections: [] });
    expect(briefCountsLine(view)).toBe("0 tabs · 0 collections");
  });

  it("counts a populated workspace and names its largest collections, deterministically", () => {
    const collections = [
      collection("c-b", "Beta", ["t1"]),
      collection("c-a", "Alpha", ["t1"]),
      collection("c-big", "Pricing Research", ["t1", "t2", "t3"]),
      collection("c-empty", "Empty", []),
      collection("c-dangling", "Dangling", ["deleted-tab"]),
      collection("c-elsewhere", "Elsewhere", ["t1"], "w2"),
    ];
    const brief = { description: "Research and organize sources.", focus: "Comparing carbon-pricing approaches.", updatedAt: T0 };
    const view = describeWorkspaceBrief({ workspace: workspace({ brief }), collections, recentChanges: 4 });
    const reversed = describeWorkspaceBrief({ workspace: workspace({ brief }), collections: [...collections].reverse(), recentChanges: 4 });
    expect(view).toEqual(reversed);
    expect(view.collections).toBe(5);
    expect(view.importantCollections.map((entry) => entry.name)).toEqual(["Pricing Research", "Alpha", "Beta"]);
    expect(view.description).toBe(brief.description);
    expect(view.focus).toBe(brief.focus);
    expect(briefCountsLine(view)).toBe("3 tabs · 5 collections · 4 recent changes");
  });

  it("names a renamed workspace by its current name, and never leaves a blank one", () => {
    expect(describeWorkspaceBrief({ workspace: workspace({ name: "Policy" }), collections: [] }).name).toBe("Policy");
    expect(describeWorkspaceBrief({ workspace: workspace({ name: "  " }), collections: [] }).name).toBe("Untitled workspace");
  });
});

describe("where a brief lives", () => {
  it("persists with the workspace, and a malformed one is repaired away without losing the workspace", () => {
    window.localStorage.clear();
    const good = setWorkspaceBrief(store(workspace()), "w1", { description: "Kept", focus: "Now" }, T0);
    saveWorkspaceStore(good);
    expect(loadWorkspaceStore()?.workspaces[0]!.brief).toEqual({ description: "Kept", focus: "Now", updatedAt: T0 });

    window.localStorage.setItem(
      "tabdump:workspaces:v1",
      JSON.stringify({ ...good, workspaces: [{ ...good.workspaces[0], brief: { description: 12, focus: ["x"] } }] })
    );
    const repaired = loadWorkspaceStore()!;
    expect(repaired.workspaces[0]!.tabs).toHaveLength(3);
    expect("brief" in repaired.workspaces[0]!).toBe(false);
    window.localStorage.clear();
  });

  it("survives a sync pull of its workspace on this device (desktop and web alike)", () => {
    const local = workspace({ brief: { description: "Mine", updatedAt: T0 } });
    const change: SyncChange = {
      operation: "upsert",
      workspaceId: "w1",
      cursor: "1",
      entityType: "workspace",
      entityId: "w1",
      entity: { id: "w1", name: "Renamed elsewhere", createdAt: T0, updatedAt: T0 + 1 },
    } as SyncChange;
    const result = applyChanges({ workspace: local, collections: [], dependencies: [] }, [change]);
    expect(result.state.workspace.name).toBe("Renamed elsewhere");
    expect(result.state.workspace.brief).toEqual({ description: "Mine", updatedAt: T0 });
  });

  it("reaches the agent's workspace copy re-read and scrubbed, and its summary", () => {
    const raw = workspace({ brief: { description: "Uses password=hunter2hunter", focus: "Now", updatedAt: T0 } });
    const snapshot = buildSessionContextSnapshot({ workspaces: [raw], collections: [], dependencies: [] }, "w1")!;
    expect(snapshot.workspace.brief?.description).not.toContain("hunter2");
    expect(summarizeWorkspace(snapshot).workspace).toMatchObject({ name: "Research", focus: "Now" });
    // A malformed brief on the wire is dropped, the workspace kept.
    const read = readSessionContextSnapshot({ ...snapshot, workspace: { ...snapshot.workspace, brief: { description: ["x"] } } }, "w1")!;
    expect(read.workspace.brief).toBeUndefined();
    expect(read.workspace.tabs).toHaveLength(3);
  });
});
