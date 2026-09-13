// @vitest-environment node
/**
 * Tombstone propagation, per-entity conflicts and account isolation, through
 * the service, against real PostgreSQL.
 *
 * ./entities.test.ts covers the same ground against the in-memory harness.
 * This re-runs the parts whose correctness depends on the database actually
 * behaving as assumed — that a tombstone survives as a row, that a stale
 * write is refused by the version the database holds rather than by one the
 * harness remembered, and that another account's data is unreachable
 * because of a foreign key and a predicate rather than a convention.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { SyncRepository } from "./repository";
import { SyncService } from "./service";
import type { SyncUpsert } from "./types";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";

const NOW = 1_700_000_000_000;

function tabPayload(id = randomUUID()) {
  return { id, url: `https://example.com/${id}`, createdAt: NOW, updatedAt: NOW };
}

describePostgres("sync entities against real PostgreSQL", () => {
  let pool: Pool;
  let repo: SyncRepository;
  let service: SyncService;
  let alice: string;
  let bob: string;
  let workspaceId: string;

  beforeEach(async () => {
    const db = await freshDatabase();
    pool = db.pool;
    repo = new SyncRepository(pool);
    service = new SyncService(pool);
    alice = await seedUser(pool, "alice");
    bob = await seedUser(pool, "bob");
    workspaceId = randomUUID();
    await service.initial(
      { workspace: { id: workspaceId, name: "Work", createdAt: NOW, updatedAt: NOW }, upserts: [] },
      alice,
      null
    );
  });

  const cursor = () => repo.getCursor(workspaceId, alice) as Promise<string>;

  const push = async (upserts: SyncUpsert[], deletes: Parameters<typeof service.push>[4] = []) =>
    service.push(workspaceId, alice, await cursor(), upserts, deletes, NOW + 1);

  // -------------------------------------------------------------------------
  // §10 Tombstone propagation, per entity type
  // -------------------------------------------------------------------------

  it("propagates a deletion for every entity type and never resurrects it from a stale push", async () => {
    const section = randomUUID();
    const group = randomUUID();
    const collection = randomUUID();
    const parent = tabPayload();
    const child = tabPayload();

    await push([
      { entityType: "section", entity: { id: section, parentId: null, name: "S", source: "user", createdAt: NOW, updatedAt: NOW } },
      { entityType: "group", entity: { id: group, name: "G", createdAt: NOW, updatedAt: NOW } },
      { entityType: "tab", entity: parent },
      { entityType: "tab", entity: child },
    ]);
    await push([
      { entityType: "collection", entity: { id: collection, name: "C", tabIds: [parent.id], createdAt: NOW, updatedAt: NOW } },
      { entityType: "dependency", entity: { parentTabId: parent.id, childTabId: child.id, createdAt: NOW } },
    ]);

    // A device that has pulled everything so far.
    const beforeDeletes = await cursor();

    const deleted = await push(
      [],
      [
        { entityType: "tab", entityId: child.id },
        { entityType: "section", entityId: section },
        { entityType: "group", entityId: group },
        { entityType: "collection", entityId: collection },
        { entityType: "dependency", parentTabId: parent.id, childTabId: child.id },
      ]
    );
    expect(deleted.ok).toBe(true);

    // A second device pulling from its old cursor learns every deletion.
    const page = await service.pull(workspaceId, alice, beforeDeletes, 500);
    const deletions = page!.changes.filter((c) => c.operation === "delete");
    expect(deletions.map((d) => d.entityType).sort()).toEqual([
      "collection",
      "dependency",
      "group",
      "section",
      "tab",
    ]);

    // Every tombstone is a surviving row, not an absence.
    for (const [table, predicate, params] of [
      ["tabdump_tabs", "id = $1", [child.id]],
      ["tabdump_sections", "id = $1", [section]],
      ["tabdump_groups", "id = $1", [group]],
      ["tabdump_collections", "id = $1", [collection]],
      ["tabdump_dependencies", "parent_tab_id = $1 AND child_tab_id = $2", [parent.id, child.id]],
    ] as const) {
      const { rows } = await pool.query(`SELECT deleted_at FROM ${table} WHERE ${predicate}`, [...params]);
      expect(rows, table).toHaveLength(1);
      expect(rows[0].deleted_at, table).not.toBeNull();
    }

    // A stale device now pushes its old copy of the deleted tab. It must be
    // refused rather than quietly undoing the deletion.
    const stale = await service.push(
      workspaceId,
      alice,
      beforeDeletes,
      [{ entityType: "tab", entity: child }],
      [],
      NOW + 2
    );
    expect(stale.ok).toBe(false);

    const { rows } = await pool.query(`SELECT deleted_at FROM tabdump_tabs WHERE id = $1`, [child.id]);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it("lets a genuine re-create clear a tombstone when the client is up to date", async () => {
    const tab = tabPayload();
    await push([{ entityType: "tab", entity: tab }]);
    await push([], [{ entityType: "tab", entityId: tab.id }]);

    // Up to date, so this is the user deliberately re-adding the tab.
    const recreated = await push([{ entityType: "tab", entity: tab }]);
    expect(recreated.ok).toBe(true);

    const { rows } = await pool.query(`SELECT deleted_at FROM tabdump_tabs WHERE id = $1`, [tab.id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // §20 Per-entity conflicts
  // -------------------------------------------------------------------------

  it("refuses a write based on a version the entity has moved past, per entity type", async () => {
    const section = randomUUID();
    const group = randomUUID();
    const collection = randomUUID();
    const tab = tabPayload();

    await push([
      { entityType: "section", entity: { id: section, parentId: null, name: "S", source: "user", createdAt: NOW, updatedAt: NOW } },
      { entityType: "group", entity: { id: group, name: "G", createdAt: NOW, updatedAt: NOW } },
      { entityType: "tab", entity: tab },
      { entityType: "collection", entity: { id: collection, name: "C", tabIds: [], createdAt: NOW, updatedAt: NOW } },
    ]);

    const cases: { name: string; upsert: SyncUpsert }[] = [
      { name: "tab", upsert: { entityType: "tab", entity: { ...tab, title: "A reads" } } },
      {
        name: "section",
        upsert: {
          entityType: "section",
          entity: { id: section, parentId: null, name: "A reads", source: "user", createdAt: NOW, updatedAt: NOW },
        },
      },
      { name: "group", upsert: { entityType: "group", entity: { id: group, name: "A reads", createdAt: NOW, updatedAt: NOW } } },
      {
        name: "collection",
        upsert: {
          entityType: "collection",
          entity: { id: collection, name: "A reads", tabIds: [], createdAt: NOW, updatedAt: NOW },
        },
      },
      {
        name: "workspace",
        upsert: {
          entityType: "workspace",
          entity: { id: workspaceId, name: "A reads", createdAt: NOW, updatedAt: NOW },
        },
      },
    ];

    for (const { name, upsert } of cases) {
      // Device A reads version N.
      const base = await cursor();
      // Device B writes N+1 for the same entity.
      const b = await service.push(workspaceId, alice, base, [upsert], [], NOW + 1);
      expect(b.ok, `${name}: B's push`).toBe(true);
      // Device A pushes based on N.
      const a = await service.push(workspaceId, alice, base, [upsert], [], NOW + 2);
      expect(a.ok, `${name}: A's stale push`).toBe(false);
      expect((a as { reason: string }).reason, name).toBe("stale-base");
    }
  });

  it("reports a per-entity conflict without writing any part of the push", async () => {
    const contested = tabPayload();
    const innocent = tabPayload();
    await push([{ entityType: "tab", entity: contested }]);

    const base = await cursor();
    // Someone else moves the contested tab forward.
    await service.push(
      workspaceId,
      alice,
      base,
      [{ entityType: "tab", entity: { ...contested, title: "moved on" } }],
      [],
      NOW + 1
    );

    // A pushes the contested tab AND an unrelated new one, from the old base.
    // The base cursor is stale, so the whole push is refused — and crucially
    // the innocent tab must not have been written.
    const result = await service.push(
      workspaceId,
      alice,
      base,
      [
        { entityType: "tab", entity: contested },
        { entityType: "tab", entity: innocent },
      ],
      [],
      NOW + 2
    );
    expect(result.ok).toBe(false);

    const { rows } = await pool.query(`SELECT id FROM tabdump_tabs WHERE id = $1`, [innocent.id]);
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // §13 Account isolation, operation by operation
  // -------------------------------------------------------------------------

  it("is indistinguishable from not-found for every operation another account attempts", async () => {
    const tab = tabPayload();
    await push([{ entityType: "tab", entity: tab }]);
    const base = await cursor();

    // discovery
    expect(await repo.listWorkspaces(bob)).toEqual([]);
    expect(await repo.getWorkspace(workspaceId, bob)).toBeNull();
    // pull
    expect(await service.pull(workspaceId, bob, "0", 500)).toBeNull();
    // push
    expect(await service.push(workspaceId, bob, base, [{ entityType: "tab", entity: tabPayload() }], [], NOW)).toEqual({
      ok: false,
      reason: "not-found",
    });
    // deletion
    expect(
      await service.push(workspaceId, bob, base, [], [{ entityType: "tab", entityId: tab.id }], NOW)
    ).toEqual({ ok: false, reason: "not-found" });

    // Nothing of Alice's moved.
    expect(await cursor()).toBe(base);
    const { rows } = await pool.query(`SELECT deleted_at FROM tabdump_tabs WHERE id = $1`, [tab.id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it("cannot be made to write into another account's workspace through a nested entity", async () => {
    const theirs = randomUUID();
    await service.initial(
      { workspace: { id: theirs, name: "Theirs", createdAt: NOW, updatedAt: NOW }, upserts: [] },
      bob,
      null
    );
    const theirTab = tabPayload();
    await service.push(
      theirs,
      bob,
      (await repo.getCursor(theirs, bob))!,
      [{ entityType: "tab", entity: theirTab }],
      [],
      NOW
    );

    // Alice pushes into HER workspace, but names Bob's tab as a dependency
    // endpoint. The composite foreign keys make that unrepresentable, so it
    // fails rather than reaching across accounts.
    const mine = tabPayload();
    await push([{ entityType: "tab", entity: mine }]);
    await expect(
      push([{ entityType: "dependency", entity: { parentTabId: mine.id, childTabId: theirTab.id, createdAt: NOW } }])
    ).rejects.toThrow(/foreign key|violates/i);

    // Bob's tab is untouched and still his.
    const { rows } = await pool.query(`SELECT workspace_id FROM tabdump_tabs WHERE id = $1`, [theirTab.id]);
    expect(rows[0].workspace_id).toBe(theirs);
  });

  // -------------------------------------------------------------------------
  // §19 Dependencies
  // -------------------------------------------------------------------------

  it("treats a duplicate dependency create as an update of the same pair", async () => {
    const parent = tabPayload();
    const child = tabPayload();
    await push([
      { entityType: "tab", entity: parent },
      { entityType: "tab", entity: child },
    ]);

    await push([{ entityType: "dependency", entity: { parentTabId: parent.id, childTabId: child.id, createdAt: NOW } }]);
    await push([
      {
        entityType: "dependency",
        entity: { parentTabId: parent.id, childTabId: child.id, type: "reference", createdAt: NOW },
      },
    ]);

    const { rows } = await pool.query(
      `SELECT type FROM tabdump_dependencies WHERE parent_tab_id = $1 AND child_tab_id = $2`,
      [parent.id, child.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("reference");
  });

  it("keeps the two directions of a pair distinct", async () => {
    const a = tabPayload();
    const b = tabPayload();
    await push([
      { entityType: "tab", entity: a },
      { entityType: "tab", entity: b },
    ]);

    await push([
      { entityType: "dependency", entity: { parentTabId: a.id, childTabId: b.id, createdAt: NOW } },
      { entityType: "dependency", entity: { parentTabId: b.id, childTabId: a.id, createdAt: NOW } },
    ]);

    const { rows } = await pool.query(`SELECT parent_tab_id FROM tabdump_dependencies WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(rows).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // §17 Payload limits against the real write path
  // -------------------------------------------------------------------------

  it("writes a large but valid push atomically", async () => {
    const tabs = Array.from({ length: 400 }, () => tabPayload());
    const result = await push(tabs.map((entity) => ({ entityType: "tab", entity })));
    expect(result.ok).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tabdump_tabs WHERE workspace_id = $1`,
      [workspaceId]
    );
    expect(Number(rows[0].count)).toBe(400);

    // ...and a second device receives all of them, across pages.
    const seen = new Set<string>();
    let cur = "0";
    for (let i = 0; i < 20; i += 1) {
      const page = await service.pull(workspaceId, alice, cur, 100);
      for (const change of page!.changes) if (change.entityType === "tab") seen.add(change.entityId!);
      cur = page!.nextCursor;
      if (!page!.hasMore) break;
    }
    expect(seen.size).toBe(400);
  });

  it("writes nothing when one entity deep in a large push is invalid", async () => {
    const good = Array.from({ length: 50 }, () => tabPayload());
    const poisoned: SyncUpsert[] = [
      ...good.map((entity) => ({ entityType: "tab" as const, entity })),
      // Passes the shape the service expects, fails the database's CHECK.
      { entityType: "tab", entity: { ...tabPayload(), confidence: 42 } },
    ];

    await expect(push(poisoned)).rejects.toThrow();

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tabdump_tabs WHERE workspace_id = $1`,
      [workspaceId]
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
