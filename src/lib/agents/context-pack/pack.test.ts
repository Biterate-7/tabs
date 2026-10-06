import { describe, expect, it } from "vitest";
import { emptyContextWorld } from "@/lib/agents/context/world";
import { collectionContext, tabsContext, workspaceContext } from "@/lib/agents/command-centre/working-context";
import { buildContextPack, CONTEXT_PACK_FINGERPRINT_PATTERN, contextPackId, isContextPackId, readPackPath } from "./pack";
import { contextPackAttachedContext, contextPackAttachments } from "./attach";
import { contextPackLine, contextPackOmittedLine, contextPackRows } from "./present";
import type { AgentContextWorld } from "@/lib/agents/context/world";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { Collection } from "@/lib/collections/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import type { ContextPack, ContextPackInput } from "./pack";

const T0 = 1_700_000_000_000;

const tab = (id: string, title: string, url = `https://${id}.example/page`): Tab => ({
  id,
  url,
  normalizedUrl: url,
  domain: new URL(url).hostname,
  title,
});

function world(over: { workspaces?: Workspace[]; collections?: Collection[]; ownerId?: string | null } = {}): AgentContextWorld {
  const research: Workspace = {
    id: "w1",
    name: "Research",
    tabs: [
      tab("t-carbon", "Carbon pricing explained"),
      tab("t-tax", "A carbon tax primer"),
      tab("t-cap", "Cap and trade"),
      tab("t-dup", "Carbon pricing explained (again)", "https://t-carbon.example/page"),
      tab("t-misc", "Unrelated"),
    ],
    brief: { description: "Research and organize sources for the climate policy project.", focus: "Comparing carbon-pricing approaches.", updatedAt: T0 },
    createdAt: T0,
    updatedAt: T0,
  };
  const other: Workspace = { id: "w2", name: "Personal", tabs: [tab("p-1", "Bank")], createdAt: T0, updatedAt: T0 };
  return {
    ...emptyContextWorld(over.ownerId === undefined ? "owner-1" : over.ownerId),
    workspaces: over.workspaces ?? [research, other],
    collections: over.collections ?? [
      { id: "c-pricing", workspaceId: "w1", name: "Pricing Research", tabIds: ["t-carbon", "t-tax", "t-cap"], createdAt: T0, updatedAt: T0 },
      { id: "c-comp", workspaceId: "w1", name: "Competitors", tabIds: ["t-misc"], createdAt: T0, updatedAt: T0 },
      { id: "c-bank", workspaceId: "w2", name: "Bank", tabIds: ["p-1"], createdAt: T0, updatedAt: T0 },
    ],
    dependencies: [{ id: "d1", parentTabId: "t-tax", childTabId: "t-carbon", createdAt: T0 }],
  };
}

function pack(input: Partial<ContextPackInput> = {}): ContextPack {
  const result = buildContextPack({ world: world(), selection: workspaceContext("w1"), ...input });
  if (!result.ok) throw new Error(`pack refused: ${result.reason}`);
  return result.pack;
}

const change = (over: Partial<AppliedWorkspaceChange> & Pick<AppliedWorkspaceChange, "id" | "at">): AppliedWorkspaceChange => ({
  sessionId: "s-other",
  provider: "gemini",
  workspaceId: "w1",
  ok: true,
  steps: [{ kind: "created", collectionId: "c-new", name: "Policy", tabCount: 2 }],
  ...over,
});

describe("one canonical Context Pack", () => {
  it("describes the whole workspace: its brief and its size, with nothing selected", () => {
    const whole = pack();
    expect(whole).toMatchObject({
      version: 1,
      scope: "workspace",
      workspace: {
        id: "w1",
        name: "Research",
        description: "Research and organize sources for the climate policy project.",
        focus: "Comparing carbon-pricing approaches.",
        tabs: 5,
        collections: 2,
      },
      collections: [],
      tabs: [],
      files: [],
      recentChanges: [],
      omitted: { missing: 0, duplicates: 0, truncated: 0 },
    });
    expect(whole.fingerprint).toMatch(CONTEXT_PACK_FINGERPRINT_PATTERN);
    expect(contextPackLine(whole)).toBe("Whole workspace · 5 tabs · 2 collections");
  });

  it("describes a collection by name, with its tabs counted", () => {
    const collection = pack({ selection: collectionContext("w1", "c-pricing") });
    expect(collection.scope).toBe("collection");
    expect(collection.collections).toEqual([{ id: "c-pricing", name: "Pricing Research", tabs: 3 }]);
    expect(contextPackLine(collection)).toBe("Collection · Pricing Research");
  });

  it("describes selected tabs with redacted addresses, and the relationships between them", () => {
    const selected = pack({ selection: tabsContext("w1", ["t-tax", "t-carbon"]) });
    expect(selected.scope).toBe("selection");
    expect(selected.tabs.map((entry) => entry.title)).toEqual(["A carbon tax primer", "Carbon pricing explained"]);
    expect(selected.tabs[0]).toMatchObject({ url: "https://t-tax.example/page", domain: "t-tax.example" });
    expect(selected.relationships).toEqual([{ id: "d1", label: "A carbon tax primer → Carbon pricing explained" }]);
  });

  it("names a custom selection the way the spec reads: collection, tabs, files", () => {
    const custom = pack({
      selection: { workspaceId: "w1", tabIds: ["t-misc"], collectionIds: ["c-pricing"] },
      files: [
        { path: "src/api.ts", change: "updated" },
        { path: "docs/plan.md", change: "created" },
      ],
    });
    expect(custom.scope).toBe("custom");
    expect(contextPackLine(custom)).toBe("Custom · Pricing Research · 1 tab · 2 files");
  });
});

describe("deterministic", () => {
  it("is the same pack, with the same fingerprint, whatever order the world and the selection arrive in", () => {
    const base = world();
    const shuffled: AgentContextWorld = {
      ...base,
      workspaces: base.workspaces.map((workspace) => ({ ...workspace, tabs: [...workspace.tabs].reverse() })).reverse(),
      collections: [...base.collections].reverse(),
    };
    const a = buildContextPack({ world: base, selection: { workspaceId: "w1", tabIds: ["t-cap", "t-tax"], collectionIds: ["c-comp", "c-pricing"] } });
    const b = buildContextPack({ world: shuffled, selection: { workspaceId: "w1", tabIds: ["t-tax", "t-cap"], collectionIds: ["c-pricing", "c-comp"] } });
    expect(a).toEqual(b);
  });

  it("orders resources by locale-independent rules", () => {
    const selected = pack({ selection: { workspaceId: "w1", tabIds: ["t-misc", "t-cap", "t-tax"], collectionIds: ["c-pricing", "c-comp"] } });
    expect(selected.collections.map((entry) => entry.name)).toEqual(["Competitors", "Pricing Research"]);
    expect(selected.tabs.map((entry) => entry.title)).toEqual(["A carbon tax primer", "Cap and trade", "Unrelated"]);
  });

  it("changes its fingerprint when the context changes — a rename, a brief, a selection — and not for the instruction", () => {
    const before = pack();
    const renamed = buildContextPack({
      world: { ...world(), workspaces: world().workspaces.map((workspace) => (workspace.id === "w1" ? { ...workspace, name: "Policy" } : workspace)) },
      selection: workspaceContext("w1"),
    });
    expect(renamed.ok && renamed.pack.fingerprint).not.toBe(before.fingerprint);
    expect(pack({ selection: collectionContext("w1", "c-comp") }).fingerprint).not.toBe(before.fingerprint);
    const instructed = pack({ instruction: "Compare the pricing models." });
    expect(instructed.instruction).toBe("Compare the pricing models.");
    expect(instructed.fingerprint).toBe(before.fingerprint);
    expect(contextPackId(before)).toBe(`pack-${before.fingerprint}`);
    expect(isContextPackId(contextPackId(before))).toBe(true);
    expect(isContextPackId("demo-snapshot-1")).toBe(false);
  });
});

describe("duplicates, stale and missing resources", () => {
  it("keeps one tab per address and says how many were left out", () => {
    const selected = pack({ selection: tabsContext("w1", ["t-dup", "t-carbon", "t-tax"]) });
    expect(selected.tabs.map((entry) => entry.id)).toEqual(["t-tax", "t-carbon"]);
    expect(selected.omitted.duplicates).toBe(1);
    expect(contextPackOmittedLine(selected)).toBe("1 duplicate tab left out.");
  });

  it("drops a deleted tab, a deleted collection and another workspace's collection, and counts them", () => {
    const stale = pack({ selection: { workspaceId: "w1", tabIds: ["t-cap", "t-deleted"], collectionIds: ["c-gone", "c-bank"] } });
    expect(stale.tabs.map((entry) => entry.id)).toEqual(["t-cap"]);
    expect(stale.collections).toEqual([]);
    expect(stale.omitted.missing).toBe(3);
    expect(contextPackOmittedLine(stale)).toBe("3 selected items are no longer in Research.");
  });

  it("refuses a workspace that no longer exists, and never reaches into another workspace", () => {
    expect(buildContextPack({ world: world(), selection: workspaceContext("w-deleted") })).toEqual({ ok: false, reason: "workspace-missing" });
    // A tab id from another workspace, named directly, is out of scope: dropped and counted.
    const reaching = pack({ selection: tabsContext("w1", ["t-cap", "p-1"]) });
    expect(reaching.tabs.map((entry) => entry.id)).toEqual(["t-cap"]);
    expect(reaching.omitted.missing).toBe(1);
    expect(JSON.stringify(reaching)).not.toContain("Bank");
    // Nor is a relationship followed out of the workspace, even from a selected tab.
    const crossing = { ...world(), dependencies: [...world().dependencies, { id: "d-out", parentTabId: "t-tax", childTabId: "p-1", createdAt: T0 }] };
    const linked = buildContextPack({ world: crossing, selection: tabsContext("w1", ["t-tax", "t-carbon"]) });
    if (!linked.ok) throw new Error("expected a pack");
    expect(linked.pack.relationships.map((relationship) => relationship.id)).toEqual(["d1"]);
    expect(JSON.stringify(contextPackAttachedContext(linked.pack, T0))).not.toContain("p-1");
  });

  it("is honest about an empty workspace, and one with no collections or files", () => {
    const empty = buildContextPack({
      world: world({ workspaces: [{ id: "w1", name: "Empty", tabs: [], createdAt: T0, updatedAt: T0 }], collections: [] }),
      selection: workspaceContext("w1"),
    });
    expect(empty.ok).toBe(true);
    const value = (empty as { ok: true; pack: ContextPack }).pack;
    expect(value.workspace).toEqual({ id: "w1", name: "Empty", tabs: 0, collections: 0 });
    expect(contextPackLine(value)).toBe("Whole workspace · 0 tabs · 0 collections");
    const rows = contextPackRows(value);
    expect(rows.find((row) => row.key === "tabs")).toMatchObject({ value: "None", empty: true });
    expect(rows.find((row) => row.key === "files")).toMatchObject({ value: "None", empty: true });
    expect(rows.some((row) => /undefined|null/.test(`${row.value} ${row.detail ?? ""}`))).toBe(false);
    expect(contextPackAttachedContext(value, T0)).toBeNull();
  });
});

describe("files, recent changes, previous result", () => {
  it("keeps project-relative files only, once each, created over edited", () => {
    const withFiles = pack({
      files: [
        { path: "src/a.ts", change: "updated" },
        { path: "src/a.ts", change: "created" },
        { path: "/etc/passwd", change: "updated" },
        { path: "../outside.ts", change: "updated" },
        { path: "C:/Windows/win.ini", change: "updated" },
        { path: "docs\\notes.md", change: "updated" },
      ],
    });
    expect(withFiles.files).toEqual([
      { path: "docs/notes.md", change: "updated" },
      { path: "src/a.ts", change: "created" },
    ]);
    expect(readPackPath("ok/path.ts")).toBe("ok/path.ts");
  });

  it("lists this workspace's applied changes, newest first — never another session's undone ones, nor the session's own", () => {
    const changes = [
      change({ id: "old", at: T0 + 1 }),
      change({ id: "new", at: T0 + 5, steps: [{ kind: "added", collectionId: "c-pricing", name: "Pricing Research", tabCount: 1 }] }),
      change({ id: "undone", at: T0 + 6, undone: true }),
      change({ id: "failed", at: T0 + 7, ok: false }),
      change({ id: "elsewhere", at: T0 + 8, workspaceId: "w2" }),
      change({ id: "mine", at: T0 + 9, sessionId: "s-me" }),
    ];
    const recent = pack({ changes, excludeChangesOf: "s-me" });
    expect(recent.recentChanges.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(recent.recentChanges[0]!.text).toBe("Added 1 tab to “Pricing Research”");
  });

  it("carries a previous result as the handoff summarized it", () => {
    const previousResult = { outcome: "finished" as const, lines: [{ title: "Created plan.md" }], more: 0, files: [{ path: "plan.md", change: "created" as const }] };
    const withResult = pack({ previousResult, files: previousResult.files });
    expect(withResult.previousResult).toEqual(previousResult);
    expect(contextPackRows(withResult).find((row) => row.key === "previousResult")).toMatchObject({ value: "Available · Finished", items: ["Created plan.md"] });
  });
});

describe("what the runtime receives", () => {
  it("attaches nothing for a whole workspace with no brief and no changes — it reads on request, as before", () => {
    const plain = buildContextPack({
      world: world({ workspaces: [{ id: "w1", name: "Plain", tabs: [tab("a", "A")], createdAt: T0, updatedAt: T0 }], collections: [] }),
      selection: workspaceContext("w1"),
    });
    expect(plain.ok && contextPackAttachedContext(plain.pack, T0)).toBeNull();
  });

  it("attaches the brief as the workspace, and the selection as its own references, under the pack's id", () => {
    const selected = pack({ selection: { workspaceId: "w1", tabIds: ["t-tax", "t-carbon"], collectionIds: ["c-pricing"] } });
    const attached = contextPackAttachedContext(selected, T0)!;
    expect(attached.snapshotId).toBe(contextPackId(selected));
    expect(attached.capturedAt).toBe(T0);
    expect(attached.attachments.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "workspace:w1",
      "collection:c-pricing",
      "tab:t-tax",
      "tab:t-carbon",
      "relationship:d1",
    ]);
    expect(attached.attachments[0]!.detail).toContain("Purpose: Research and organize sources");
    expect(attached.attachments[0]!.detail).toContain("Current focus: Comparing carbon-pricing approaches.");
    expect(contextPackAttachments(selected)).toEqual(attached.attachments);
  });
});
