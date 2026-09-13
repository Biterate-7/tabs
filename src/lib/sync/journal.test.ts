import { beforeEach, describe, expect, it } from "vitest";
import {
  addDirty,
  backoffDelayMs,
  clearDirty,
  defaultJournal,
  defaultJournalStore,
  getJournal,
  loadJournalStore,
  removeConflict,
  saveJournalStore,
  setJournal,
  upsertConflicts,
} from "./journal";
import type { WorkspaceJournal } from "./journal";
import type { LocalSyncConflict } from "./conflicts";
import {
  buildConflict,
  conflictId,
  favoursLocalManualIntent,
  resolveKeepLocal,
  resolveKeepRemote,
} from "./conflicts";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

const T0 = 1_700_000_000_000;
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const TAB_A = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";
const SECTION_A = "44444444-4444-4444-8444-444444444444";
const SECTION_B = "55555555-5555-4555-8555-555555555555";

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
    sections: [{ id: SECTION_A, parentId: null, name: "Root", source: "ai", createdAt: T0, updatedAt: T0 }],
    groups: [],
    tabs: [tab({ id: TAB_A, title: "Mine" }), tab({ id: TAB_B })],
    ...over,
  };
}

describe("the dirty set coalesces", () => {
  it("keeps one entry however many times an entity is edited", () => {
    let journal = defaultJournal(WS);
    for (let i = 0; i < 20; i++) {
      journal = addDirty(journal, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    }
    // Twenty edits, one upsert. This is why the journal is a set rather than
    // a log: the push sends current state, so repeats add nothing.
    expect(journal.dirty).toHaveLength(1);
  });

  it("lets a later delete supersede an earlier edit", () => {
    let journal = addDirty(defaultJournal(WS), [
      { ref: { entityType: "tab", entityId: TAB_A }, deleted: false },
    ]);
    journal = addDirty(journal, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: true }]);
    expect(journal.dirty).toEqual([{ ref: { entityType: "tab", entityId: TAB_A }, deleted: true }]);
  });

  it("lets a re-creation supersede a delete", () => {
    let journal = addDirty(defaultJournal(WS), [
      { ref: { entityType: "tab", entityId: TAB_A }, deleted: true },
    ]);
    journal = addDirty(journal, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    expect(journal.dirty[0].deleted).toBe(false);
  });

  it("keeps different entities apart", () => {
    const journal = addDirty(defaultJournal(WS), [
      { ref: { entityType: "tab", entityId: TAB_A }, deleted: false },
      { ref: { entityType: "tab", entityId: TAB_B }, deleted: false },
      { ref: { entityType: "section", entityId: SECTION_A }, deleted: false },
    ]);
    expect(journal.dirty).toHaveLength(3);
  });

  it("clears only what was actually sent", () => {
    const journal = addDirty(defaultJournal(WS), [
      { ref: { entityType: "tab", entityId: TAB_A }, deleted: false },
      { ref: { entityType: "tab", entityId: TAB_B }, deleted: false },
    ]);
    const after = clearDirty(journal, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    // An edit made while the request was in flight must survive; clearing the
    // whole set would lose it silently.
    expect(after.dirty).toEqual([{ ref: { entityType: "tab", entityId: TAB_B }, deleted: false }]);
  });

  it("is pure", () => {
    const journal = defaultJournal(WS);
    addDirty(journal, [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
    expect(journal.dirty).toEqual([]);
  });
});

describe("durability", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips through localStorage", () => {
    const journal: WorkspaceJournal = {
      ...defaultJournal(WS),
      status: "queued",
      cursor: "42",
      dirty: [{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }],
      failureCount: 2,
    };
    saveJournalStore(setJournal(defaultJournalStore(), USER, journal));

    const restored = getJournal(loadJournalStore(), USER, WS);
    expect(restored.cursor).toBe("42");
    expect(restored.dirty).toHaveLength(1);
    expect(restored.failureCount).toBe(2);
  });

  it("never restores a syncing state", () => {
    saveJournalStore(
      setJournal(defaultJournalStore(), USER, { ...defaultJournal(WS), status: "syncing", cursor: "5" })
    );
    // No request can still be in flight across a reload, and leaving it there
    // would strand the workspace in a state nothing clears.
    expect(getJournal(loadJournalStore(), USER, WS).status).toBe("queued");
  });

  it("survives a corrupted blob rather than preventing startup", () => {
    window.localStorage.setItem("tabdump:sync-journal:v1", "{ not json");
    expect(loadJournalStore()).toEqual(defaultJournalStore());

    window.localStorage.setItem(
      "tabdump:sync-journal:v1",
      JSON.stringify({ version: 1, userId: USER, workspaces: { [WS]: { nonsense: true } } })
    );
    expect(loadJournalStore().workspaces).toEqual({});
  });

  it("drops malformed dirty entries without losing the good ones", () => {
    window.localStorage.setItem(
      "tabdump:sync-journal:v1",
      JSON.stringify({
        version: 1,
        userId: USER,
        workspaces: {
          [WS]: {
            workspaceId: WS,
            status: "queued",
            cursor: "1",
            dirty: [{ ref: { entityType: "tab", entityId: TAB_A } }, { nonsense: true }, { ref: {} }],
            conflicts: [],
            failureCount: 0,
          },
        },
      })
    );
    expect(getJournal(loadJournalStore(), USER, WS).dirty).toHaveLength(1);
  });

  it("does not hand a different account the previous one's journal", () => {
    saveJournalStore(
      setJournal(defaultJournalStore(), USER, { ...defaultJournal(WS), status: "idle", cursor: "42" })
    );
    const other = getJournal(loadJournalStore(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", WS);
    expect(other.cursor).toBe("0");
    expect(other.status).toBe("never-synced");
  });

  it("starts a clean blob when the account changes", () => {
    const first = setJournal(defaultJournalStore(), USER, { ...defaultJournal(WS), cursor: "42" });
    const second = setJournal(first, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", defaultJournal(WS));
    expect(Object.keys(second.workspaces)).toEqual([WS]);
    expect(second.workspaces[WS].cursor).toBe("0");
  });

  it("lives outside workspace data, so it cannot reach an export", () => {
    saveJournalStore(setJournal(defaultJournalStore(), USER, { ...defaultJournal(WS), cursor: "42" }));
    expect(window.localStorage.getItem("tabdump:sync-journal:v1")).toBeTruthy();
    // The export reads tabdump:workspaces:v1 and knows nothing about this key.
    expect(window.localStorage.getItem("tabdump:workspaces:v1")).toBeNull();
  });
});

describe("backoff", () => {
  it("grows with each failure and stays bounded", () => {
    const fixed = () => 1;
    const delays = [1, 2, 3, 4, 5, 10, 20].map((n) => backoffDelayMs(n, fixed));
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    // Capped: an unbounded retry loop is a denial of service aimed at our own
    // server.
    expect(Math.max(...delays)).toBeLessThanOrEqual(5 * 60_000);
  });

  it("jitters, so a fleet of reconnecting clients does not retry in lockstep", () => {
    expect(backoffDelayMs(5, () => 0)).toBeLessThan(backoffDelayMs(5, () => 1));
  });
});

describe("conflict records", () => {
  const base = {
    workspaceId: WS,
    entityType: "tab" as const,
    entityId: TAB_A,
    reason: "changed-since-base" as const,
    workspace: workspace(),
    baseCursor: "10",
    serverCursor: "12",
    now: T0,
  };

  it("captures the local payload so it survives later local changes", () => {
    const conflict = buildConflict({ ...base, remote: null });
    expect(conflict.local?.entityType).toBe("tab");
    if (conflict.local?.entityType !== "tab") return;
    expect(conflict.local.entity.title).toBe("Mine");
  });

  it("uses a deterministic id, so re-detecting one does not accumulate duplicates", () => {
    const a = buildConflict({ ...base, remote: null });
    const b = buildConflict({ ...base, remote: null, now: T0 + 5000 });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(conflictId(WS, "tab", TAB_A));

    const journal = upsertConflicts(upsertConflicts(defaultJournal(WS), [a]), [b]);
    expect(journal.conflicts).toHaveLength(1);
  });

  it("returns the workspace to ordinary work when the last conflict clears", () => {
    const conflict = buildConflict({ ...base, remote: null });
    const withConflict = upsertConflicts(defaultJournal(WS), [conflict]);
    expect(withConflict.status).toBe("conflict");

    const cleared = removeConflict(withConflict, conflict.id);
    expect(cleared.conflicts).toHaveLength(0);
    expect(cleared.status).toBe("idle");
  });

  it("stays in conflict while others remain", () => {
    const a = buildConflict({ ...base, remote: null });
    const b = buildConflict({ ...base, entityId: TAB_B, remote: null });
    const journal = upsertConflicts(defaultJournal(WS), [a, b]);
    expect(removeConflict(journal, a.id).status).toBe("conflict");
  });
});

describe("resolution", () => {
  const remoteTab = {
    entityType: "tab" as const,
    entity: { id: TAB_A, url: `https://example.com/${TAB_A}`, title: "Theirs" },
  };

  function conflict(over: Partial<LocalSyncConflict> = {}): LocalSyncConflict {
    return {
      ...buildConflict({
        workspaceId: WS,
        entityType: "tab",
        entityId: TAB_A,
        reason: "changed-since-base",
        workspace: workspace(),
        remote: remoteTab,
        baseCursor: "10",
        serverCursor: "12",
        now: T0,
      }),
      ...over,
    };
  }

  it("keep-local leaves state alone and re-queues the entity", () => {
    const ws = workspace();
    const result = resolveKeepLocal(conflict(), ws);
    expect(result.workspace).toBe(ws);
    // The resolution becomes a real mutation pushed against the server's new
    // cursor, rather than a record quietly deleted.
    expect(result.dirty).toEqual([{ ref: { entityType: "tab", entityId: TAB_A }, deleted: false }]);
  });

  it("keep-remote applies the server value and queues nothing", () => {
    const result = resolveKeepRemote(conflict(), workspace());
    expect(result.workspace.tabs.find((t) => t.id === TAB_A)?.title).toBe("Theirs");
    // Pushing the server's own value back is the loop this design forbids.
    expect(result.dirty).toEqual([]);
  });

  it("keep-remote preserves derived local fields", () => {
    const result = resolveKeepRemote(conflict(), workspace());
    const applied = result.workspace.tabs.find((t) => t.id === TAB_A)!;
    // normalizedUrl and domain are recomputed locally and are not on the
    // wire; taking the remote value must not blank them.
    expect(applied.domain).toBe("example.com");
    expect(applied.normalizedUrl).toBeTruthy();
  });

  it("keep-remote honours a remote deletion", () => {
    const result = resolveKeepRemote(conflict({ remote: null, reason: "local-edit-remote-delete" }), workspace());
    expect(result.workspace.tabs.find((t) => t.id === TAB_A)).toBeUndefined();
    expect(result.dirty).toEqual([]);
  });

  it("keep-local on a local deletion re-queues the delete", () => {
    const result = resolveKeepLocal(conflict({ local: null, reason: "local-delete-remote-edit" }), workspace());
    expect(result.dirty).toEqual([{ ref: { entityType: "tab", entityId: TAB_A }, deleted: true }]);
  });

  it("does not mutate the workspace it is given", () => {
    const ws = workspace();
    const before = JSON.stringify(ws);
    resolveKeepRemote(conflict(), ws);
    resolveKeepLocal(conflict(), ws);
    expect(JSON.stringify(ws)).toBe(before);
  });
});

describe("manual organization has special standing", () => {
  it("flags a locked-section conflict", () => {
    const locked = buildConflict({
      workspaceId: WS,
      entityType: "tab",
      entityId: TAB_A,
      reason: "locked-section",
      workspace: workspace(),
      remote: null,
      baseCursor: "10",
      serverCursor: "12",
      now: T0,
    });
    expect(favoursLocalManualIntent(locked)).toBe(true);
  });

  it("flags a conflict whose local side was placed by hand", () => {
    const manual = buildConflict({
      workspaceId: WS,
      entityType: "tab",
      entityId: TAB_A,
      reason: "changed-since-base",
      workspace: workspace({
        tabs: [tab({ id: TAB_A, sectionId: SECTION_B, sectionLocked: true }), tab({ id: TAB_B })],
      }),
      remote: null,
      baseCursor: "10",
      serverCursor: "12",
      now: T0,
    });
    // sectionLocked says a human placed this. The UI should say so rather
    // than offering two equivalent-looking buttons.
    expect(favoursLocalManualIntent(manual)).toBe(true);
  });

  it("does not flag an ordinary conflict", () => {
    const plain = buildConflict({
      workspaceId: WS,
      entityType: "tab",
      entityId: TAB_A,
      reason: "changed-since-base",
      workspace: workspace(),
      remote: null,
      baseCursor: "10",
      serverCursor: "12",
      now: T0,
    });
    expect(favoursLocalManualIntent(plain)).toBe(false);
  });
});
