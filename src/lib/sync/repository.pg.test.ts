// @vitest-environment node
/**
 * SyncRepository against real PostgreSQL.
 *
 * ./repository.test.ts already covers this class against a recording fake:
 * it proves the SQL is shaped as intended and that the right statements run
 * in the right order. What it cannot prove is that Postgres AGREES —
 * that the composite foreign keys actually reject a cross-workspace child,
 * that `FOR UPDATE` actually serializes two racing pushes, that a failure
 * mid-transaction actually rolls the earlier writes back. Those are
 * properties of the database, so they are tested against a database.
 *
 * Every test here therefore does something the fake cannot: it asserts on
 * what is COMMITTED, by reading it back on a different connection.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { SyncRepository } from "./repository";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";

const NOW = 1_700_000_000_000;

function workspacePayload(overrides: Partial<{ id: string; name: string }> = {}) {
  return { id: overrides.id ?? randomUUID(), name: overrides.name ?? "Work", createdAt: NOW, updatedAt: NOW };
}

function tabPayload(overrides: Partial<{ id: string; url: string; sectionId: string; groupId: string }> = {}) {
  return {
    id: overrides.id ?? randomUUID(),
    url: overrides.url ?? "https://example.com/a",
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides.sectionId ? { sectionId: overrides.sectionId } : {}),
    ...(overrides.groupId ? { groupId: overrides.groupId } : {}),
  };
}

describePostgres("SyncRepository against real PostgreSQL", () => {
  let pool: Pool;
  let repo: SyncRepository;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    const db = await freshDatabase();
    pool = db.pool;
    repo = new SyncRepository(pool);
    alice = await seedUser(pool, "alice");
    bob = await seedUser(pool, "bob");
  });

  // -------------------------------------------------------------------------
  // §4 Ownership and the same-workspace invariant
  // -------------------------------------------------------------------------

  it("ties a workspace to exactly one owner, enforced by a real foreign key", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    expect(await repo.getWorkspace(ws.id, alice)).toMatchObject({ id: ws.id, name: "Work" });
    // Indistinguishable from "does not exist" — a guessed id reveals nothing.
    expect(await repo.getWorkspace(ws.id, bob)).toBeNull();
    expect(await repo.listWorkspaces(bob)).toEqual([]);
  });

  it("rejects a workspace owned by a user that does not exist", async () => {
    await expect(repo.createWorkspace(workspacePayload(), randomUUID())).rejects.toThrow(
      /foreign key|violates/i
    );
  });

  it("makes a cross-workspace section reference unrepresentable", async () => {
    const mine = workspacePayload();
    const theirs = workspacePayload();
    await repo.createWorkspace(mine, alice);
    await repo.createWorkspace(theirs, bob);

    const foreignSection = randomUUID();
    await repo.mutateWorkspace(theirs.id, bob, {}, async (m) => {
      await m.upsertSection({
        id: foreignSection,
        parentId: null,
        name: "Theirs",
        source: "user",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    // The composite FK (workspace_id, section_id) -> (workspace_id, id) has
    // no satisfying row, because the section lives in another workspace.
    await expect(
      repo.mutateWorkspace(mine.id, alice, {}, async (m) => {
        await m.upsertTab(tabPayload({ sectionId: foreignSection }));
      })
    ).rejects.toThrow(/foreign key|violates/i);

    const { rows } = await pool.query(`SELECT id FROM tabdump_tabs WHERE workspace_id = $1`, [mine.id]);
    expect(rows).toEqual([]);
  });

  it("makes a cross-workspace dependency unrepresentable", async () => {
    const mine = workspacePayload();
    const theirs = workspacePayload();
    await repo.createWorkspace(mine, alice);
    await repo.createWorkspace(theirs, bob);

    const myTab = tabPayload();
    const theirTab = tabPayload();
    await repo.mutateWorkspace(mine.id, alice, {}, async (m) => m.upsertTab(myTab));
    await repo.mutateWorkspace(theirs.id, bob, {}, async (m) => m.upsertTab(theirTab));

    // Both composite keys reference the SAME workspace_id column, so no row
    // can satisfy both while the tabs live in different workspaces.
    await expect(
      repo.mutateWorkspace(mine.id, alice, {}, async (m) => {
        await m.upsertDependency({ parentTabId: myTab.id, childTabId: theirTab.id, createdAt: NOW });
      })
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("rejects a dependency whose parent or child does not exist", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const real = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(real));

    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertDependency({ parentTabId: real.id, childTabId: randomUUID(), createdAt: NOW });
      })
    ).rejects.toThrow(/foreign key|violates/i);

    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertDependency({ parentTabId: randomUUID(), childTabId: real.id, createdAt: NOW });
      })
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("keeps (parent, child) as the dependency identity across a re-create", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const parent = tabPayload();
    const child = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertTab(parent);
      await m.upsertTab(child);
    });

    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertDependency({ parentTabId: parent.id, childTabId: child.id, type: "research", createdAt: NOW });
    });
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertDependency({ parentTabId: parent.id, childTabId: child.id, type: "tool", createdAt: NOW });
    });

    // Upserting the same pair updates in place — it never becomes two rows.
    const { rows } = await pool.query(
      `SELECT type FROM tabdump_dependencies WHERE parent_tab_id = $1 AND child_tab_id = $2`,
      [parent.id, child.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("tool");
  });

  it("refuses to move an entity between workspaces by re-upserting its id", async () => {
    const mine = workspacePayload();
    const theirs = workspacePayload();
    await repo.createWorkspace(mine, alice);
    await repo.createWorkspace(theirs, bob);

    const tab = tabPayload();
    await repo.mutateWorkspace(theirs.id, bob, {}, async (m) => m.upsertTab(tab));

    // The upsert's WHERE workspace_id = EXCLUDED.workspace_id makes this a
    // no-op rather than a workspace-transfer primitive.
    await repo.mutateWorkspace(mine.id, alice, {}, async (m) => {
      await m.upsertTab({ ...tab, url: "https://stolen.example/" });
    });

    const { rows } = await pool.query(`SELECT workspace_id, url FROM tabdump_tabs WHERE id = $1`, [tab.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(theirs.id);
    expect(rows[0].url).toBe("https://example.com/a");
  });

  // -------------------------------------------------------------------------
  // §5 Transactions
  // -------------------------------------------------------------------------

  it("rolls back every earlier write when a later one fails", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const cursorBefore = await repo.getCursor(ws.id, alice);

    const goodA = tabPayload();
    const goodB = tabPayload();

    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertTab(goodA);
        await m.upsertTab(goodB);
        // Violates tabdump_tabs_section_same_workspace: no such section.
        await m.upsertTab(tabPayload({ sectionId: randomUUID() }));
      })
    ).rejects.toThrow();

    const { rows } = await pool.query(`SELECT id FROM tabdump_tabs WHERE workspace_id = $1`, [ws.id]);
    expect(rows).toEqual([]);

    // ...and a failed push must not consume a durable version.
    expect(await repo.getCursor(ws.id, alice)).toBe(cursorBefore);
  });

  it("commits a multi-entity push as one indivisible step", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const section = randomUUID();
    const group = randomUUID();
    const tabA = tabPayload();
    const tabB = tabPayload();

    const result = await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertSection({ id: section, parentId: null, name: "S", source: "user", createdAt: NOW, updatedAt: NOW });
      await m.upsertGroup({ id: group, name: "G", createdAt: NOW, updatedAt: NOW });
      await m.upsertTab({ ...tabA, sectionId: section, groupId: group });
      await m.upsertTab(tabB);
    });

    expect(result).toMatchObject({ ok: true });

    // Every row from one transaction shares one version, so a bulk change is
    // one step in the change stream rather than four interleavable ones.
    const { rows } = await pool.query<{ sync_version: string }>(
      `SELECT sync_version FROM tabdump_tabs WHERE workspace_id = $1
       UNION SELECT sync_version FROM tabdump_sections WHERE workspace_id = $1
       UNION SELECT sync_version FROM tabdump_groups WHERE workspace_id = $1`,
      [ws.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sync_version).toBe((result as { cursor: string }).cursor);
  });

  it("uses a deferred constraint so a section and its tabs can be written in either order", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const section = randomUUID();

    // The tab references the section BEFORE the section exists. This is only
    // legal because the composite FK is INITIALLY DEFERRED.
    const result = await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertTab(tabPayload({ sectionId: section }));
      await m.upsertSection({ id: section, parentId: null, name: "S", source: "user", createdAt: NOW, updatedAt: NOW });
    });

    expect(result).toMatchObject({ ok: true });
  });

  // -------------------------------------------------------------------------
  // §6 The workspace sync counter
  // -------------------------------------------------------------------------

  it("advances the counter by exactly one per successful push, and never backwards", async () => {
    const ws = workspacePayload();
    const created = await repo.createWorkspace(ws, alice);
    expect(created).toBe("1");

    const seen: string[] = [created];
    for (let i = 0; i < 5; i += 1) {
      const result = await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tabPayload()));
      expect(result.ok).toBe(true);
      seen.push((result as { cursor: string }).cursor);
    }

    expect(seen).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(await repo.getCursor(ws.id, alice)).toBe("6");
  });

  it("consumes a version for an empty push but never rewinds", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const empty = await repo.mutateWorkspace(ws.id, alice, {}, async () => {});
    expect(empty).toEqual({ ok: true, cursor: "2" });
    expect(await repo.getCursor(ws.id, alice)).toBe("2");
  });

  it("leaves the counter untouched when the workspace is not owned by the caller", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const result = await repo.mutateWorkspace(ws.id, bob, {}, async (m) => m.upsertTab(tabPayload()));
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(await repo.getCursor(ws.id, alice)).toBe("1");
    expect(await repo.getCursor(ws.id, bob)).toBeNull();
  });

  it("rejects a stale base without consuming a version", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tabPayload()));

    const stale = await repo.mutateWorkspace(ws.id, alice, { expectedCursor: "1" }, async (m) =>
      m.upsertTab(tabPayload())
    );
    expect(stale).toEqual({ ok: false, reason: "conflict", cursor: "2" });
    expect(await repo.getCursor(ws.id, alice)).toBe("2");
  });

  // -------------------------------------------------------------------------
  // §10 Tombstones
  // -------------------------------------------------------------------------

  it("keeps a tombstoned row so the deletion can still propagate", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const tab = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tab));

    const deleted = await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.deleteTab(tab.id, NOW + 5));
    const cursor = (deleted as { cursor: string }).cursor;

    // The row survives with deleted_at set — a DELETE could never be reported
    // to a client asking "what changed since X".
    const { rows } = await pool.query<{ deleted_at: string; sync_version: string }>(
      `SELECT deleted_at, sync_version FROM tabdump_tabs WHERE id = $1`,
      [tab.id]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].deleted_at)).toBe(NOW + 5);
    expect(rows[0].sync_version).toBe(cursor);

    const changes = await repo.getTabChangesSince(ws.id, alice, "0", 50);
    expect(changes?.map((t) => t.id)).toContain(tab.id);
  });

  it("hides a tombstoned workspace from discovery without destroying its rows", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const tab = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tab));

    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.deleteWorkspace(NOW + 9));

    expect(await repo.listWorkspaces(alice)).toEqual([]);
    expect(await repo.getWorkspace(ws.id, alice)).toBeNull();

    // Children are deliberately left alone: they are unreachable, and
    // tombstoning them all would turn one deletion into a workspace-wide write.
    const { rows } = await pool.query(`SELECT deleted_at FROM tabdump_tabs WHERE id = $1`, [tab.id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it("still reports the cursor of a tombstoned workspace so a stale device can learn of the deletion", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.deleteWorkspace(NOW + 9));

    // getCursor deliberately has no `deleted_at IS NULL` predicate.
    expect(await repo.getCursor(ws.id, alice)).toBe("2");
  });

  // -------------------------------------------------------------------------
  // §18 Collections
  // -------------------------------------------------------------------------

  it("stores collection membership in the client's order and replaces it wholesale", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const a = tabPayload();
    const b = tabPayload();
    const c = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertTab(a);
      await m.upsertTab(b);
      await m.upsertTab(c);
    });

    const collection = randomUUID();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertCollection({ id: collection, name: "C", tabIds: [c.id, a.id], createdAt: NOW, updatedAt: NOW });
    });

    const read = async () => {
      const { rows } = await pool.query<{ tab_id: string }>(
        `SELECT tab_id FROM tabdump_collection_tabs WHERE collection_id = $1 ORDER BY position`,
        [collection]
      );
      return rows.map((r) => r.tab_id);
    };
    expect(await read()).toEqual([c.id, a.id]);

    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertCollection({ id: collection, name: "C", tabIds: [b.id, c.id, a.id], createdAt: NOW, updatedAt: NOW });
    });
    expect(await read()).toEqual([b.id, c.id, a.id]);
  });

  it("enforces one collection per tab", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const tab = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tab));

    const first = randomUUID();
    const second = randomUUID();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      await m.upsertCollection({ id: first, name: "1", tabIds: [tab.id], createdAt: NOW, updatedAt: NOW });
    });

    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertCollection({ id: second, name: "2", tabIds: [tab.id], createdAt: NOW, updatedAt: NOW });
      })
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("refuses collection membership pointing at another workspace's tab", async () => {
    const mine = workspacePayload();
    const theirs = workspacePayload();
    await repo.createWorkspace(mine, alice);
    await repo.createWorkspace(theirs, bob);

    const theirTab = tabPayload();
    await repo.mutateWorkspace(theirs.id, bob, {}, async (m) => m.upsertTab(theirTab));

    await expect(
      repo.mutateWorkspace(mine.id, alice, {}, async (m) => {
        await m.upsertCollection({
          id: randomUUID(),
          name: "C",
          tabIds: [theirTab.id],
          createdAt: NOW,
          updatedAt: NOW,
        });
      })
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // -------------------------------------------------------------------------
  // §16 Database constraints as the second line of defence
  // -------------------------------------------------------------------------

  it("rejects values that slipped past application validation", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    // confidence outside [0,1]
    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertTab({ ...tabPayload(), confidence: 5 });
      })
    ).rejects.toThrow(/confidence_range|violates/i);

    // an organization_status the client model does not define
    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertTab({
          ...tabPayload(),
          organizationStatus: "bogus" as unknown as "manual",
        });
      })
    ).rejects.toThrow(/org_status_valid|violates/i);

    // an over-long url
    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertTab({ ...tabPayload(), url: `https://example.com/${"x".repeat(4100)}` });
      })
    ).rejects.toThrow(/url_len|violates/i);

    // a self-referential dependency
    const tab = tabPayload();
    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tab));
    await expect(
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertDependency({ parentTabId: tab.id, childTabId: tab.id, createdAt: NOW });
      })
    ).rejects.toThrow(/not_self|violates/i);
  });

  it("stores a client-minted id verbatim and never remaps it", async () => {
    const id = randomUUID();
    const ws = workspacePayload({ id });
    await repo.createWorkspace(ws, alice);
    expect((await repo.getWorkspace(id, alice))?.id).toBe(id);
  });

  it("rejects a legacy non-uuid id at the column type, as schema.sql documents", async () => {
    await expect(
      repo.createWorkspace({ ...workspacePayload(), id: "ws-1699999999999-3" }, alice)
    ).rejects.toThrow(/invalid input syntax for type uuid/i);
  });
});
