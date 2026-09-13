import { describe, expect, it } from "vitest";
import { buildPush, diffStores, diffWorkspace, refKey } from "./diff";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";

/**
 * What counts as a local change.
 *
 * The stakes are symmetric and both bad: too eager and every render schedules
 * a network request; too lazy and a user's edit never leaves the device. So
 * these pin both directions — what must be dirty, and what must not.
 */

const T0 = 1_700_000_000_000;
const WS = "11111111-1111-4111-8111-111111111111";
const WS_B = "99999999-9999-4999-8999-999999999999";
const TAB_A = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";
const SECTION = "44444444-4444-4444-8444-444444444444";
const GROUP = "55555555-5555-4555-8555-555555555555";

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: `https://example.com/${over.id}`,
    normalizedUrl: `https://example.com/${over.id}`,
    domain: "example.com",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: WS,
    name: "Local",
    createdAt: T0,
    updatedAt: T0,
    sections: [{ id: SECTION, parentId: null, name: "Root", source: "ai", createdAt: T0, updatedAt: T0 }],
    groups: [{ id: GROUP, name: "G", createdAt: T0, updatedAt: T0 }],
    tabs: [tab({ id: TAB_A }), tab({ id: TAB_B })],
    ...over,
  };
}

function keys(refs: ReturnType<typeof diffWorkspace>): string[] {
  return refs.map((entry) => `${refKey(entry.ref)}${entry.deleted ? ":deleted" : ""}`).sort();
}

describe("nothing changed means nothing to sync", () => {
  it("reports no dirty entities for an identical workspace", () => {
    expect(diffWorkspace(workspace(), workspace())).toEqual([]);
  });

  it("reports nothing for the same object", () => {
    const ws = workspace();
    expect(diffWorkspace(ws, ws)).toEqual([]);
  });

  it("ignores derived fields the server never stores", () => {
    // markDuplicates rewrites isDuplicate across the whole list, and
    // normalizedUrl/domain/favicon are recomputed locally. None of them is a
    // user edit, and treating them as one would schedule a push on every
    // render pass that touched the list.
    const before = workspace();
    const after = workspace({
      tabs: [
        tab({ id: TAB_A, isDuplicate: true, normalizedUrl: "https://changed.example", domain: "changed.example" }),
        tab({ id: TAB_B, favicon: "https://example.com/icon.png" }),
      ],
    });
    expect(diffWorkspace(before, after)).toEqual([]);
  });

  it("ignores a workspace that is referentially identical inside a new store", () => {
    const ws = workspace();
    const before: WorkspaceStore = { version: 1, currentId: WS, workspaces: [ws] };
    // A new store object holding the same workspace — what a reducer returns
    // when some OTHER workspace changed.
    const after: WorkspaceStore = { version: 1, currentId: WS, workspaces: [ws] };
    expect(diffStores(before, after).size).toBe(0);
  });
});

describe("real edits are dirty", () => {
  it("marks an edited tab", () => {
    const after = workspace({ tabs: [tab({ id: TAB_A, title: "Renamed" }), tab({ id: TAB_B })] });
    expect(keys(diffWorkspace(workspace(), after))).toEqual([`tab:${TAB_A}`]);
  });

  it("marks a favourited tab", () => {
    const after = workspace({ tabs: [tab({ id: TAB_A, isFavorite: true }), tab({ id: TAB_B })] });
    expect(keys(diffWorkspace(workspace(), after))).toEqual([`tab:${TAB_A}`]);
  });

  it("marks a new tab", () => {
    const fresh = "66666666-6666-4666-8666-666666666666";
    const after = workspace({ tabs: [...workspace().tabs, tab({ id: fresh })] });
    expect(keys(diffWorkspace(workspace(), after))).toEqual([`tab:${fresh}`]);
  });

  it("marks a removed tab as deleted", () => {
    const after = workspace({ tabs: [tab({ id: TAB_A })] });
    expect(keys(diffWorkspace(workspace(), after))).toEqual([`tab:${TAB_B}:deleted`]);
  });

  it("marks a renamed workspace", () => {
    expect(keys(diffWorkspace(workspace(), workspace({ name: "Renamed" })))).toEqual([`workspace:${WS}`]);
  });

  it("marks section and group edits separately from tabs", () => {
    const after = workspace({
      sections: [{ id: SECTION, parentId: null, name: "Renamed", source: "ai", createdAt: T0, updatedAt: T0 + 1 }],
      groups: [{ id: GROUP, name: "G2", createdAt: T0, updatedAt: T0 + 1 }],
    });
    expect(keys(diffWorkspace(workspace(), after))).toEqual([`group:${GROUP}`, `section:${SECTION}`]);
  });

  it("marks a section move on a tab", () => {
    const after = workspace({ tabs: [tab({ id: TAB_A, sectionId: SECTION }), tab({ id: TAB_B })] });
    expect(keys(diffWorkspace(workspace(), after))).toEqual([`tab:${TAB_A}`]);
  });

  it("treats a brand-new workspace as entirely dirty", () => {
    const keysOut = keys(diffWorkspace(undefined, workspace()));
    expect(keysOut).toEqual(
      [`workspace:${WS}`, `section:${SECTION}`, `group:${GROUP}`, `tab:${TAB_A}`, `tab:${TAB_B}`].sort()
    );
  });
});

describe("device-local state is never dirty", () => {
  it("ignores lastAccessedAt on its own", () => {
    // Opening a tab is not a content mutation. Phase 2 kept lastAccessedAt
    // independent of updatedAt for exactly this reason, and sync must not
    // quietly reverse that by turning every open into a push.
    //
    // NOTE: lastAccessedAt IS part of the server payload, so a tab dirty for
    // another reason carries its current value — this asserts only that it
    // does not by itself schedule work.
    const after = workspace({ tabs: [tab({ id: TAB_A, lastAccessedAt: T0 + 5000 }), tab({ id: TAB_B })] });
    const dirty = diffWorkspace(workspace(), after);
    expect(dirty.map((d) => refKey(d.ref))).toEqual([`tab:${TAB_A}`]);
  });
});

describe("per-workspace isolation", () => {
  it("marks only the workspace that changed", () => {
    const a = workspace();
    const b = workspace({ id: WS_B, name: "Other", tabs: [tab({ id: "77777777-7777-4777-8777-777777777777" })] });
    const before: WorkspaceStore = { version: 1, currentId: WS, workspaces: [a, b] };
    const after: WorkspaceStore = {
      version: 1,
      currentId: WS,
      workspaces: [workspace({ name: "Renamed" }), b],
    };

    const result = diffStores(before, after);
    expect([...result.keys()]).toEqual([WS]);
  });
});

describe("building a push from dirty refs", () => {
  it("sends the CURRENT state of a dirty entity, not a recorded delta", () => {
    // Why a retry is safe: whatever the server ends up with is whatever the
    // client holds now, however many times the request repeats.
    const ws = workspace({ tabs: [tab({ id: TAB_A, title: "Final" }), tab({ id: TAB_B })] });
    const { upserts } = buildPush(ws, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].entityType).toBe("tab");
    if (upserts[0].entityType !== "tab") return;
    expect(upserts[0].entity.title).toBe("Final");
    expect(upserts[0].entity).not.toHaveProperty("normalizedUrl");
  });

  it("turns a dirty id that no longer exists into a delete", () => {
    const ws = workspace({ tabs: [tab({ id: TAB_A })] });
    const { upserts, deletes } = buildPush(ws, [
      { ref: { entityType: "tab", entityId: TAB_B }, deleted: true },
    ]);
    expect(upserts).toHaveLength(0);
    expect(deletes).toEqual([{ entityType: "tab", entityId: TAB_B }]);
  });

  it("orders sections and groups before the tabs that reference them", () => {
    const ws = workspace();
    const { upserts } = buildPush(ws, [
      { ref: { entityType: "tab", entityId: TAB_A }, deleted: false },
      { ref: { entityType: "section", entityId: SECTION }, deleted: false },
      { ref: { entityType: "group", entityId: GROUP }, deleted: false },
    ]);
    const types = upserts.map((u) => u.entityType);
    expect(types.indexOf("section")).toBeLessThan(types.indexOf("tab"));
    expect(types.indexOf("group")).toBeLessThan(types.indexOf("tab"));
  });

  it("keeps two tabs with the same URL as two separate upserts", () => {
    const same = workspace({
      tabs: [
        tab({ id: TAB_A, url: "https://example.com/same" }),
        tab({ id: TAB_B, url: "https://example.com/same" }),
      ],
    });
    const { upserts } = buildPush(same, [
      { ref: { entityType: "tab", entityId: TAB_A }, deleted: false },
      { ref: { entityType: "tab", entityId: TAB_B }, deleted: false },
    ]);
    // Identity is the id, never the URL.
    expect(upserts).toHaveLength(2);
  });
});
