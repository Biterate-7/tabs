// @vitest-environment node
/**
 * Concurrency against real PostgreSQL.
 *
 * These are the tests that cannot be faked at all. Serialization, row
 * locking, lost updates and creation races are properties of the database's
 * concurrency control; a harness that runs operations one after another
 * proves nothing about them no matter how carefully it is written.
 *
 * Every test here therefore drives two or more genuinely concurrent
 * connections at the same rows and asserts on what Postgres actually did.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { SyncRepository } from "./repository";
import { SyncService } from "./service";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";

const NOW = 1_700_000_000_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tabPayload(id = randomUUID()) {
  return { id, url: `https://example.com/${id}`, createdAt: NOW, updatedAt: NOW };
}

function workspacePayload(id = randomUUID()) {
  return { id, name: "Work", createdAt: NOW, updatedAt: NOW };
}

describePostgres("sync concurrency against real PostgreSQL", () => {
  let pool: Pool;
  let repo: SyncRepository;
  let alice: string;

  beforeEach(async () => {
    const db = await freshDatabase();
    pool = db.pool;
    repo = new SyncRepository(pool);
    alice = await seedUser(pool, "alice");
  });

  // -------------------------------------------------------------------------
  // §7 Concurrent pushes
  // -------------------------------------------------------------------------

  it("serializes two pushes on the workspace row lock", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const order: string[] = [];
    const holdA = deferred();

    const pushA = repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      order.push("A-enter");
      await m.upsertTab(tabPayload());
      await holdA.promise;
      order.push("A-leave");
    });

    // Wait until A is demonstrably inside its transaction holding the lock.
    while (!order.includes("A-enter")) await tick(5);

    const pushB = repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      order.push("B-enter");
      await m.upsertTab(tabPayload());
    });

    // B must be parked on SELECT ... FOR UPDATE. If the lock were missing,
    // B would sail into its callback here and the order below would differ.
    await tick(250);
    expect(order).toEqual(["A-enter"]);

    holdA.resolve();
    const [a, b] = await Promise.all([pushA, pushB]);

    expect(order).toEqual(["A-enter", "A-leave", "B-enter"]);
    expect(a).toEqual({ ok: true, cursor: "2" });
    expect(b).toEqual({ ok: true, cursor: "3" });
  });

  it("hands out strictly increasing, unique versions under a burst of concurrent pushes", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const PUSHES = 6;
    const results = await Promise.all(
      Array.from({ length: PUSHES }, () =>
        repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tabPayload()))
      )
    );

    const cursors = results.map((r) => Number((r as { cursor: string }).cursor));
    // No duplicate accepted versions, and no gaps: exactly 2..7.
    expect([...cursors].sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(new Set(cursors).size).toBe(PUSHES);
    expect(await repo.getCursor(ws.id, alice)).toBe("7");

    // No lost updates: every push's row is present.
    const { rows } = await pool.query(`SELECT id FROM tabdump_tabs WHERE workspace_id = $1`, [ws.id]);
    expect(rows).toHaveLength(PUSHES);
  });

  it("rejects the loser of a base-cursor race instead of losing its write", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);
    const base = await repo.getCursor(ws.id, alice);

    // Both devices push from the same base. Exactly one may win.
    const [first, second] = await Promise.all([
      repo.mutateWorkspace(ws.id, alice, { expectedCursor: base! }, async (m) => m.upsertTab(tabPayload())),
      repo.mutateWorkspace(ws.id, alice, { expectedCursor: base! }, async (m) => m.upsertTab(tabPayload())),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const loser = outcomes.find((r) => !r.ok) as { ok: false; reason: string; cursor?: string };
    expect(loser.reason).toBe("conflict");
    // The loser is told where the server actually is, so it can re-read.
    expect(loser.cursor).toBe("2");

    const { rows } = await pool.query(`SELECT id FROM tabdump_tabs WHERE workspace_id = $1`, [ws.id]);
    expect(rows).toHaveLength(1);
  });

  it("keeps ownership intact when another account pushes concurrently", async () => {
    const bob = await seedUser(pool, "bob");
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const [mine, theirs] = await Promise.all([
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tabPayload())),
      repo.mutateWorkspace(ws.id, bob, {}, async (m) => m.upsertTab(tabPayload())),
    ]);

    expect(mine).toMatchObject({ ok: true });
    expect(theirs).toEqual({ ok: false, reason: "not-found" });

    const { rows } = await pool.query(`SELECT user_id FROM tabdump_workspaces WHERE id = $1`, [ws.id]);
    expect(rows[0].user_id).toBe(alice);
    const tabs = await pool.query(`SELECT id FROM tabdump_tabs WHERE workspace_id = $1`, [ws.id]);
    expect(tabs.rows).toHaveLength(1);
  });

  it("does not consume a version when a concurrent push rolls back", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const [ok, failed] = await Promise.allSettled([
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.upsertTab(tabPayload())),
      repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
        await m.upsertTab({ ...tabPayload(), sectionId: randomUUID() });
      }),
    ]);

    expect(ok.status).toBe("fulfilled");
    expect(failed.status).toBe("rejected");

    // The failed transaction's counter bump rolled back with it, so the
    // durable counter reflects only the push that committed.
    expect(await repo.getCursor(ws.id, alice)).toBe("2");
  });

  // -------------------------------------------------------------------------
  // §8 Concurrent initial workspace creation
  // -------------------------------------------------------------------------

  it("lets only one of several simultaneous first uploads create the workspace", async () => {
    const service = new SyncService(pool);
    const ws = workspacePayload();

    // More than two, because which interleaving occurs is up to the
    // scheduler: some attempts lose at the ownership check and some lose at
    // the INSERT. Every one of them must produce a defined answer.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => service.initial({ workspace: ws, upserts: [] }, alice, null))
    );

    const created = outcomes.filter((r) => r.ok && r.created);
    const refused = outcomes.filter((r) => !r.ok);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(4);
    // The deterministic second-device answer, never an internal error.
    for (const outcome of refused) {
      expect((outcome as { reason: string }).reason).toBe("already-exists");
      expect((outcome as { serverCursor: string }).serverCursor).toBeTruthy();
    }

    // Exactly one workspace row, and no partial workspace left behind.
    const { rows } = await pool.query(`SELECT id, user_id FROM tabdump_workspaces WHERE id = $1`, [ws.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(alice);
  });

  it("refuses a first upload of an id another account already owns, without disturbing it", async () => {
    const bob = await seedUser(pool, "bob");
    const service = new SyncService(pool);
    const ws = workspacePayload();

    await service.initial({ workspace: ws, upserts: [] }, bob, null);
    const stolen = await service.initial({ workspace: { ...ws, name: "Mine now" }, upserts: [] }, alice, null);

    expect(stolen.ok).toBe(false);
    // Refused as `conflict`, not as a raw database error and not as
    // `already-exists`: Alice must not be told the workspace is "already on
    // the server, sync it here" for something she can never read, and the
    // answer must not carry Bob's cursor.
    expect((stolen as { reason: string }).reason).toBe("conflict");
    expect((stolen as { serverCursor: string }).serverCursor).toBe("0");

    const { rows } = await pool.query(`SELECT user_id, name FROM tabdump_workspaces WHERE id = $1`, [ws.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(bob);
    expect(rows[0].name).toBe("Work");
  });

  // -------------------------------------------------------------------------
  // §9 Deletion racing an update
  // -------------------------------------------------------------------------

  it("never resurrects a workspace when a deletion and an update race", async () => {
    const ws = workspacePayload();
    await repo.createWorkspace(ws, alice);

    const order: string[] = [];
    const holdDelete = deferred();

    const deletion = repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      order.push("delete-enter");
      await m.deleteWorkspace(NOW + 1);
      await holdDelete.promise;
    });
    while (!order.includes("delete-enter")) await tick(5);

    // The update is parked behind the deletion's row lock.
    const update = repo.mutateWorkspace(ws.id, alice, {}, async (m) => {
      order.push("update-enter");
      await m.upsertTab(tabPayload());
    });
    await tick(200);
    expect(order).toEqual(["delete-enter"]);

    holdDelete.resolve();
    await Promise.all([deletion, update]);

    // The update ran second and wrote a tab, but it must NOT have cleared
    // the workspace tombstone — deleted_at is untouched by any write except
    // an explicit workspace upsert.
    const { rows } = await pool.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM tabdump_workspaces WHERE id = $1`,
      [ws.id]
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(await repo.listWorkspaces(alice)).toEqual([]);
    expect(await repo.getWorkspace(ws.id, alice)).toBeNull();
  });

  it("does not let a stale push resurrect a deleted workspace through the service", async () => {
    const service = new SyncService(pool);
    const ws = workspacePayload();
    await service.initial({ workspace: ws, upserts: [] }, alice, null);
    const base = await repo.getCursor(ws.id, alice);

    await repo.mutateWorkspace(ws.id, alice, {}, async (m) => m.deleteWorkspace(NOW + 1));

    // A device that never heard about the deletion pushes from its old base.
    const stale = await service.push(
      ws.id,
      alice,
      base!,
      [{ entityType: "tab", entity: tabPayload() }],
      [],
      NOW + 2
    );

    // Refused as stale-base: the deletion moved the workspace's cursor, so
    // the device's old base no longer matches.
    expect(stale).toMatchObject({ ok: false, reason: "stale-base" });
    const { rows } = await pool.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM tabdump_workspaces WHERE id = $1`,
      [ws.id]
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });
});
