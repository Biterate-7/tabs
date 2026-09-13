// @vitest-environment node
/**
 * Pull: pagination, cursor boundaries and snapshot consistency, against real
 * PostgreSQL.
 *
 * A pull reads six tables. Whether those six reads see ONE state of the
 * workspace or six different ones is a property of the transaction they run
 * in — so it can only be tested against a database that really has
 * transactions, with a real commit really landing in the middle.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { SyncRepository } from "./repository";
import { SyncService } from "./service";
import type { SyncChange } from "./types";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";

const NOW = 1_700_000_000_000;

function tabPayload(id = randomUUID()) {
  return { id, url: `https://example.com/${id}`, createdAt: NOW, updatedAt: NOW };
}

/** The tab changes' ids. `filter` alone would not narrow the change union, which has no `entityId` on its dependency arm. */
function tabIds(changes: readonly SyncChange[]): string[] {
  return changes.flatMap((change) => (change.entityType === "tab" ? [change.entityId] : []));
}

/** A stable identity for any change, dependencies (whose identity is a pair) included. */
function changeKey(change: SyncChange): string {
  return change.entityType === "dependency"
    ? `dependency:${change.parentTabId}::${change.childTabId}`
    : `${change.entityType}:${change.entityId}`;
}

describePostgres("sync pull against real PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let pool: Pool;
  let repo: SyncRepository;
  let service: SyncService;
  let alice: string;
  let workspaceId: string;

  beforeEach(async () => {
    db = await freshDatabase();
    pool = db.pool;
    repo = new SyncRepository(pool);
    service = new SyncService(pool);
    alice = await seedUser(pool, "alice");
    workspaceId = randomUUID();
    await repo.createWorkspace({ id: workspaceId, name: "Work", createdAt: NOW, updatedAt: NOW }, alice);
  });

  // -------------------------------------------------------------------------
  // §11 Pagination
  // -------------------------------------------------------------------------

  it("walks every change exactly once across pages, in cursor order", async () => {
    // 12 pushes, each its own version, so paging has real boundaries to cut at.
    const written: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const tab = tabPayload();
      written.push(tab.id);
      await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tab));
    }

    const seen: string[] = [];
    const cursors: number[] = [];
    let cursor = "0";
    let guard = 0;

    for (;;) {
      const page = await service.pull(workspaceId, alice, cursor, 5);
      expect(page).not.toBeNull();
      for (const change of page!.changes) {
        if (change.entityType === "tab") seen.push(change.entityId);
        cursors.push(Number(change.cursor));
      }
      cursor = page!.nextCursor;
      if (!page!.hasMore) break;
      if ((guard += 1) > 20) throw new Error("pagination did not terminate");
    }

    // Nothing skipped, nothing duplicated.
    expect(seen.sort()).toEqual([...written].sort());
    expect(new Set(seen).size).toBe(written.length);
    // Never out of cursor order.
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
  });

  it("never splits one transaction across two pages", async () => {
    // One push writing eight tabs — all share a version.
    const bulk = Array.from({ length: 8 }, () => tabPayload());
    await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => {
      for (const tab of bulk) await m.upsertTab(tab);
    });
    const after = tabPayload();
    await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(after));

    // From cursor 1, past the workspace's own creation, so the bulk version
    // is the first thing the page meets. A limit smaller than that version:
    // the page must still carry the whole of it rather than half.
    const page = await service.pull(workspaceId, alice, "1", 3);
    const versions = new Set(page!.changes.map((c) => c.cursor));
    expect(versions.size).toBe(1);
    expect(page!.changes).toHaveLength(8);
    expect(page!.hasMore).toBe(true);
  });

  it("delivers a version larger than the page limit in full, not just the first limit+1 rows", async () => {
    // The regression this guards is silent data loss, not a slow sync.
    //
    // One push may write up to SYNC_LIMITS.entitiesPerPush (10_000) rows
    // under a single version, while a pull page is 500. The per-table reads
    // fetch `limit + 1` rows, so a version bigger than that can never be
    // collected whole — and because every row shares the version, the page
    // ends at it and `nextCursor` advances past it. Every row that was never
    // fetched is then permanently unreachable: the client only ever asks for
    // changes ABOVE its cursor again.
    //
    // A 600-tab workspace uploaded from one device and pulled by another is
    // enough to trigger it.
    const bulk = Array.from({ length: 25 }, () => tabPayload());
    await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => {
      for (const tab of bulk) await m.upsertTab(tab);
    });

    const page = await service.pull(workspaceId, alice, "1", 5);
    expect(tabIds(page!.changes).sort()).toEqual(bulk.map((t) => t.id).sort());

    // And walking the pages must still surface every row exactly once.
    const seen = new Set<string>();
    let cursor = "0";
    for (let i = 0; i < 10; i += 1) {
      const next = await service.pull(workspaceId, alice, cursor, 5);
      for (const change of next!.changes) if (change.entityType === "tab") seen.add(change.entityId);
      cursor = next!.nextCursor;
      if (!next!.hasMore) break;
    }
    expect(seen.size).toBe(bulk.length);
  });

  it("resumes safely when a client drops a page and re-asks from its last cursor", async () => {
    for (let i = 0; i < 6; i += 1) {
      await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
    }

    const first = await service.pull(workspaceId, alice, "0", 2);
    // Simulate the response never arriving: the client retries the SAME
    // cursor it already had rather than the one it never saw.
    const retried = await service.pull(workspaceId, alice, "0", 2);
    expect(retried!.changes.map(changeKey)).toEqual(first!.changes.map(changeKey));
    expect(retried!.nextCursor).toBe(first!.nextCursor);
  });

  // -------------------------------------------------------------------------
  // §12 Cursor boundaries
  // -------------------------------------------------------------------------

  it("honours the exact cursor boundaries", async () => {
    await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
    await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
    const current = Number(await repo.getCursor(workspaceId, alice));
    expect(current).toBe(3);

    // cursor = 0 — everything, including the workspace's own creation.
    const fromZero = await service.pull(workspaceId, alice, "0", 500);
    expect(fromZero!.changes.length).toBeGreaterThan(0);
    expect(fromZero!.nextCursor).toBe(String(current));
    expect(fromZero!.hasMore).toBe(false);

    // cursor = current — caught up, and the cursor must not move.
    const atCurrent = await service.pull(workspaceId, alice, String(current), 500);
    expect(atCurrent!.changes).toEqual([]);
    expect(atCurrent!.nextCursor).toBe(String(current));
    expect(atCurrent!.hasMore).toBe(false);

    // cursor = current - 1 — strictly greater-than, so only the last version.
    const oneBack = await service.pull(workspaceId, alice, String(current - 1), 500);
    expect(oneBack!.changes.every((c) => c.cursor === String(current))).toBe(true);
    expect(oneBack!.changes.length).toBeGreaterThan(0);

    // cursor > current — a client must never be able to carry a cursor
    // beyond applied data, and asking with one must not invent changes or
    // rewind it into the past.
    const ahead = await service.pull(workspaceId, alice, String(current + 50), 500);
    expect(ahead!.changes).toEqual([]);
    expect(ahead!.nextCursor).toBe(String(current + 50));
    expect(ahead!.hasMore).toBe(false);
  });

  it("refuses a pull for a workspace the caller does not own", async () => {
    const bob = await seedUser(pool, "bob");
    expect(await service.pull(workspaceId, bob, "0", 500)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Snapshot consistency
  // -------------------------------------------------------------------------

  it("reads all six tables from one snapshot, so a mid-pull commit cannot tear a page", async () => {
    // A pull reads workspaces, sections, groups, tabs, collections and
    // dependencies in sequence. Without a single snapshot each read sees a
    // different committed state, so a push landing between two of them is
    // visible to the later reads and invisible to the earlier ones. The page
    // would then carry PART of that push while its nextCursor advanced past
    // it — and the client would never ask for the missing part again.
    //
    // This drives exactly that interleaving: a real push commits on another
    // connection the moment the tabs read returns, writing a tab and a
    // dependency under one version.
    const parent = tabPayload();
    const child = tabPayload();
    await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => {
      await m.upsertTab(parent);
      await m.upsertTab(child);
    });

    const writerPool = await db.openPool();
    const writer = new SyncRepository(writerPool);
    const lateTab = tabPayload();
    let interleaved: string | null = null;

    const proxyPool = {
      query: (...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args),
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property !== "query") return Reflect.get(target, property, receiver);
            return async (...args: unknown[]) => {
              const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
              const text = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
              if (interleaved === null && text.includes("tabdump_tabs") && text.includes("sync_version >")) {
                const push = await writer.mutateWorkspace(workspaceId, alice, {}, async (m) => {
                  await m.upsertTab(lateTab);
                  await m.upsertDependency({
                    parentTabId: parent.id,
                    childTabId: child.id,
                    createdAt: NOW,
                  });
                });
                interleaved = (push as { cursor: string }).cursor;
              }
              return result;
            };
          },
        }) as PoolClient;
      },
    };

    const page = await new SyncService(proxyPool as unknown as Pool).pull(workspaceId, alice, "0", 500);
    expect(interleaved).not.toBeNull();

    const reachedInterleaved = Number(page!.nextCursor) >= Number(interleaved);
    if (reachedInterleaved) {
      // If the page advanced far enough to include the interleaved push, it
      // must carry ALL of it — not just the dependency the later read saw.
      const ids = tabIds(page!.changes);
      expect(ids).toContain(lateTab.id);
    } else {
      // Or it excluded the push entirely, which is equally consistent: the
      // client will pick it up on the next pull.
      expect(page!.changes.some((c) => c.cursor === interleaved)).toBe(false);
    }
  });
});
