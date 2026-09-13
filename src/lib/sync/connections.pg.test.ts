// @vitest-environment node
/**
 * Connection and transaction lifecycle, against a real pool.
 *
 * A leaked client is invisible in a fake: nothing runs out. Against a real
 * pool with a real ceiling it is unmissable — once `max` clients are checked
 * out and never returned, the next acquisition blocks forever and the test
 * times out. So these deliberately run more operations than the pool has
 * connections, and mix in the failure paths, which are where a missing
 * `release()` actually hides.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { SyncRepository } from "./repository";
import { SyncService } from "./service";
import { describePostgres, freshDatabase, seedUser } from "../../../test/pg/database";

const NOW = 1_700_000_000_000;

function tabPayload(id = randomUUID()) {
  return { id, url: `https://example.com/${id}`, createdAt: NOW, updatedAt: NOW };
}

describePostgres("sync connection handling against real PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let pool: Pool;
  let alice: string;
  let workspaceId: string;

  beforeEach(async () => {
    db = await freshDatabase();
    pool = db.pool;
    alice = await seedUser(pool, "alice");
    workspaceId = randomUUID();
    await new SyncRepository(pool).createWorkspace(
      { id: workspaceId, name: "Work", createdAt: NOW, updatedAt: NOW },
      alice
    );
  });

  /** A pool small enough that a single leak exhausts it within the loop below. */
  async function smallPool(): Promise<Pool> {
    const { Pool } = await import("pg");
    const created = new Pool({ connectionString: db.url, max: 2 });
    // Registered for the harness's afterEach cleanup via openPool's list is
    // not possible here, so close it explicitly at the end of each test.
    return created;
  }

  it("returns the client after a successful mutation", async () => {
    const small = await smallPool();
    try {
      const repo = new SyncRepository(small);
      for (let i = 0; i < 8; i += 1) {
        const result = await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
        expect(result.ok).toBe(true);
      }
      expect(small.idleCount).toBeGreaterThan(0);
      expect(small.totalCount).toBeLessThanOrEqual(2);
    } finally {
      await small.end();
    }
  });

  it("returns the client after a mutation rolls back", async () => {
    const small = await smallPool();
    try {
      const repo = new SyncRepository(small);
      // Eight failures through a pool of two: a client leaked on the error
      // path would strand the pool by the third iteration.
      for (let i = 0; i < 8; i += 1) {
        await expect(
          repo.mutateWorkspace(workspaceId, alice, {}, async (m) => {
            await m.upsertTab({ ...tabPayload(), sectionId: randomUUID() });
          })
        ).rejects.toThrow();
      }

      // Still usable afterwards, which is the property that matters.
      const after = await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
      expect(after.ok).toBe(true);
      expect(small.idleCount).toBeGreaterThan(0);
    } finally {
      await small.end();
    }
  });

  it("returns the client when ownership refuses the mutation before any write", async () => {
    const small = await smallPool();
    try {
      const bob = await seedUser(pool, "bob");
      const repo = new SyncRepository(small);
      for (let i = 0; i < 8; i += 1) {
        expect(await repo.mutateWorkspace(workspaceId, bob, {}, async (m) => m.upsertTab(tabPayload()))).toEqual({
          ok: false,
          reason: "not-found",
        });
      }
      const after = await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
      expect(after.ok).toBe(true);
    } finally {
      await small.end();
    }
  });

  it("returns the client when a push is refused for a stale base", async () => {
    const small = await smallPool();
    try {
      const repo = new SyncRepository(small);
      for (let i = 0; i < 8; i += 1) {
        const result = await repo.mutateWorkspace(
          workspaceId,
          alice,
          { expectedCursor: "999" },
          async (m) => m.upsertTab(tabPayload())
        );
        expect(result).toMatchObject({ ok: false, reason: "conflict" });
      }
      const after = await repo.mutateWorkspace(workspaceId, alice, {}, async (m) => m.upsertTab(tabPayload()));
      expect(after.ok).toBe(true);
    } finally {
      await small.end();
    }
  });

  it("returns the client after a pull, including a failing one", async () => {
    const small = await smallPool();
    try {
      const service = new SyncService(small);
      for (let i = 0; i < 8; i += 1) {
        const page = await service.pull(workspaceId, alice, "0", 50);
        expect(page).not.toBeNull();
      }

      // A pull whose read fails must also release. `readChangesSince` runs
      // inside the pull's own transaction, so a malformed cursor fails there
      // rather than at the ownership check.
      for (let i = 0; i < 8; i += 1) {
        await expect(service.pull(workspaceId, alice, "not-a-number", 50)).rejects.toThrow();
      }

      const after = await service.pull(workspaceId, alice, "0", 50);
      expect(after).not.toBeNull();
      expect(small.idleCount).toBeGreaterThan(0);
    } finally {
      await small.end();
    }
  });

  it("leaves no transaction open on the connection it hands back", async () => {
    const small = await smallPool();
    try {
      const repo = new SyncRepository(small);
      await expect(
        repo.mutateWorkspace(workspaceId, alice, {}, async (m) => {
          await m.upsertTab({ ...tabPayload(), sectionId: randomUUID() });
        })
      ).rejects.toThrow();

      // A connection returned mid-transaction would report a state other
      // than "idle" and would poison whoever picked it up next.
      const { rows } = await small.query<{ state: string }>(
        `SELECT state FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`
      );
      for (const row of rows) {
        expect(row.state, "a pooled connection was left inside a transaction").not.toBe(
          "idle in transaction"
        );
      }
    } finally {
      await small.end();
    }
  });
});
