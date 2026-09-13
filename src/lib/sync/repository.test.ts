import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SyncRepository } from "./repository";

/**
 * These exercise the repository against a recording fake rather than a real
 * Postgres — there is no database in this environment, the same constraint
 * src/lib/auth/store/postgres.test.ts already records.
 *
 * That bounds what they can prove. They pin the SQL shape, the
 * parameterization, the ownership predicates and the transaction structure —
 * the defect class that actually bites here, which is a query that forgets
 * `user_id` and therefore reads another account's workspace. They do NOT
 * prove the schema applies, that a foreign key rejects a cross-workspace
 * row, or that FOR UPDATE actually serializes anything. Those need a real
 * database and remain a manual step.
 */

type Recorded = { text: string; values: unknown[] };

class FakeClient {
  readonly queries: Recorded[] = [];
  released = false;
  private responses: Record<string, unknown>[][] = [];

  willReturn(rows: Record<string, unknown>[]): void {
    this.responses.push(rows);
  }

  async query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    // Transaction control returns no rows in Postgres, so it must not
    // consume a queued response — otherwise every later result is off by
    // one and the fake silently misrepresents the driver.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rows: [] };
    return { rows: this.responses.shift() ?? [] };
  }

  release(): void {
    this.released = true;
  }

  /** Every statement normalized to one line, so assertions don't depend on wrapping. */
  get sql(): string[] {
    return this.queries.map((q) => q.text.replace(/\s+/g, " ").trim());
  }
}

class FakePool {
  readonly queries: Recorded[] = [];
  readonly client = new FakeClient();
  private responses: Record<string, unknown>[][] = [];

  willReturn(rows: Record<string, unknown>[]): void {
    this.responses.push(rows);
  }

  async query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    return { rows: this.responses.shift() ?? [] };
  }

  async connect() {
    return this.client;
  }

  get lastSql(): string {
    return this.queries[this.queries.length - 1].text.replace(/\s+/g, " ").trim();
  }

  get lastValues(): unknown[] {
    return this.queries[this.queries.length - 1].values;
  }
}

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TAB = "22222222-2222-4222-8222-222222222222";
const TAB_B = "33333333-3333-4333-8333-333333333333";
const SECTION = "44444444-4444-4444-8444-444444444444";
const COLLECTION = "55555555-5555-4555-8555-555555555555";
const T0 = 1_700_000_000_000;

let pool: FakePool;
let repo: SyncRepository;

beforeEach(() => {
  pool = new FakePool();
  repo = new SyncRepository(pool as unknown as Pool);
});

describe("every read is scoped to the session's user", () => {
  it("filters listWorkspaces by user_id", async () => {
    await repo.listWorkspaces(USER);
    expect(pool.lastSql).toContain("WHERE user_id = $1");
    expect(pool.lastValues).toEqual([USER]);
  });

  it("requires both the id and the owner to read one workspace", async () => {
    await repo.getWorkspace(WORKSPACE, USER);
    expect(pool.lastSql).toContain("WHERE id = $1 AND user_id = $2");
    expect(pool.lastValues).toEqual([WORKSPACE, USER]);
  });

  it("returns null for a workspace owned by someone else, indistinguishably from one that does not exist", async () => {
    // The fake returns no rows, which is what Postgres does when the
    // user_id predicate excludes the row. A guessed id therefore reveals
    // nothing — not even whether it is real.
    pool.willReturn([]);
    expect(await repo.getWorkspace(WORKSPACE, OTHER_USER)).toBeNull();
  });

  it("hides existence through getCursor the same way", async () => {
    pool.willReturn([]);
    expect(await repo.getCursor(WORKSPACE, OTHER_USER)).toBeNull();
    expect(pool.lastSql).toContain("WHERE id = $1 AND user_id = $2");
  });

  it("refuses to read changes without first confirming ownership", async () => {
    pool.willReturn([]); // getCursor finds nothing
    const changes = await repo.getTabChangesSince(WORKSPACE, OTHER_USER, "0", 100);
    expect(changes).toBeNull();
    // Exactly one query ran: the ownership check. The tab read never happened.
    expect(pool.queries).toHaveLength(1);
    expect(pool.lastSql).toContain("user_id = $2");
  });

  it("reads changes in version order once ownership is established", async () => {
    pool.willReturn([{ sync_counter: "7" }]);
    pool.willReturn([]);
    await repo.getTabChangesSince(WORKSPACE, USER, "3", 100);
    expect(pool.lastSql).toContain("WHERE workspace_id = $1 AND sync_version > $2");
    expect(pool.lastSql).toContain("ORDER BY sync_version");
    expect(pool.lastValues).toEqual([WORKSPACE, "3", 100]);
  });

  it("does not filter tombstones out of the change stream", async () => {
    // A deleted row must still be reported, or the deletion never reaches
    // another device. This is the one read where deleted_at must NOT appear
    // in the WHERE clause.
    pool.willReturn([{ sync_counter: "7" }]);
    pool.willReturn([]);
    await repo.getTabChangesSince(WORKSPACE, USER, "0", 100);
    expect(pool.lastSql).not.toContain("deleted_at IS NULL");
  });

  it("does hide tombstoned workspaces from ordinary reads", async () => {
    await repo.listWorkspaces(USER);
    expect(pool.lastSql).toContain("deleted_at IS NULL");
  });
});

describe("client-generated identity is preserved", () => {
  it("inserts the workspace id it was given and never generates one", async () => {
    pool.willReturn([{ sync_counter: "1" }]);
    await repo.createWorkspace(
      { id: WORKSPACE, name: "General", createdAt: T0, updatedAt: T0 },
      USER
    );
    expect(pool.lastValues[0]).toBe(WORKSPACE);
    expect(pool.lastSql).not.toMatch(/gen_random_uuid|DEFAULT/i);
  });

  it("takes the owner from the argument, not from the payload", async () => {
    pool.willReturn([{ sync_counter: "1" }]);
    // A hostile payload carrying its own owner field cannot reach the INSERT:
    // the type has no such field and the value inserted is the caller's.
    await repo.createWorkspace(
      { id: WORKSPACE, name: "General", createdAt: T0, updatedAt: T0 },
      USER
    );
    expect(pool.lastValues[1]).toBe(USER);
    expect(pool.lastValues).not.toContain(OTHER_USER);
  });
});

describe("mutations are transactional and ownership-gated", () => {
  it("locks the workspace for this user before writing anything", async () => {
    pool.client.willReturn([{ sync_counter: "4" }]); // SELECT ... FOR UPDATE
    pool.client.willReturn([{ sync_counter: "5" }]); // UPDATE ... RETURNING

    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.upsertTab({ id: TAB, url: "https://example.com/a" });
    });

    const sql = pool.client.sql;
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("WHERE id = $1 AND user_id = $2 FOR UPDATE");
    expect(pool.client.queries[1].values).toEqual([WORKSPACE, USER]);
    expect(sql[sql.length - 1]).toBe("COMMIT");
  });

  it("rolls back and writes nothing when the user does not own the workspace", async () => {
    pool.client.willReturn([]); // the FOR UPDATE select finds no row

    let ran = false;
    const result = await repo.mutateWorkspace(WORKSPACE, OTHER_USER, {}, async () => {
      ran = true;
    });

    expect(result).toEqual({ ok: false, reason: "not-found" });
    // The caller's writes never executed, so nothing can have leaked into
    // another account's workspace.
    expect(ran).toBe(false);
    expect(pool.client.sql).toEqual(["BEGIN", expect.stringContaining("FOR UPDATE"), "ROLLBACK"]);
    expect(pool.client.released).toBe(true);
  });

  it("refuses a stale write when the client's cursor no longer matches", async () => {
    pool.client.willReturn([{ sync_counter: "9" }]);

    let ran = false;
    const result = await repo.mutateWorkspace(WORKSPACE, USER, { expectedCursor: "4" }, async () => {
      ran = true;
    });

    expect(result).toEqual({ ok: false, reason: "conflict", cursor: "9" });
    expect(ran).toBe(false);
    expect(pool.client.sql).toContain("ROLLBACK");
  });

  it("proceeds when the cursor still matches", async () => {
    pool.client.willReturn([{ sync_counter: "4" }]);
    pool.client.willReturn([{ sync_counter: "5" }]);

    const result = await repo.mutateWorkspace(WORKSPACE, USER, { expectedCursor: "4" }, async () => {});
    expect(result).toEqual({ ok: true, cursor: "5" });
  });

  it("gives every row in one bulk mutation the same version", async () => {
    pool.client.willReturn([{ sync_counter: "4" }]);
    pool.client.willReturn([{ sync_counter: "5" }]);

    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.upsertTab({ id: TAB, url: "https://example.com/a" });
      await m.upsertTab({ id: TAB_B, url: "https://example.com/b" });
      await m.upsertSection({ id: SECTION, parentId: null, name: "P", source: "ai", createdAt: T0, updatedAt: T0 });
      await m.deleteTab(TAB, T0);
    });

    // One transaction, one version: a bulk operation is a single indivisible
    // step in the change stream rather than four interleavable ones.
    //
    // Scoped to entity writes on purpose. The counter bump on
    // tabdump_workspaces carries no version (it is what MINTS the version),
    // and collection-membership rows carry none either (they are versioned
    // through their collection) — so neither belongs in this count.
    const entityWrites = pool.client.queries.filter((q) =>
      /INSERT INTO tabdump_(tabs|sections|groups|collections|dependencies)\b|SET deleted_at/.test(q.text)
    );
    expect(entityWrites.length).toBe(4);
    for (const q of entityWrites) {
      expect(q.values, q.text.slice(0, 40)).toContain("5");
    }
  });

  it("rolls back and releases the connection when a write throws", async () => {
    pool.client.willReturn([{ sync_counter: "4" }]);
    pool.client.willReturn([{ sync_counter: "5" }]);

    await expect(
      repo.mutateWorkspace(WORKSPACE, USER, {}, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(pool.client.sql).toContain("ROLLBACK");
    expect(pool.client.sql).not.toContain("COMMIT");
    // A leaked connection exhausts a pool of 3 very quickly.
    expect(pool.client.released).toBe(true);
  });
});

describe("upserts cannot move a row between workspaces", () => {
  beforeEach(() => {
    pool.client.willReturn([{ sync_counter: "4" }]);
    pool.client.willReturn([{ sync_counter: "5" }]);
  });

  it("guards the conflict branch of every upsert with the workspace", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.upsertTab({ id: TAB, url: "https://example.com/a" });
      await m.upsertSection({ id: SECTION, parentId: null, name: "P", source: "ai", createdAt: T0, updatedAt: T0 });
      await m.upsertGroup({ id: SECTION, name: "G", createdAt: T0, updatedAt: T0 });
      await m.upsertCollection({ id: COLLECTION, name: "C", tabIds: [], createdAt: T0, updatedAt: T0 });
      await m.upsertDependency({ parentTabId: TAB, childTabId: TAB_B, createdAt: T0 });
    });

    // Without this predicate an upsert would be a workspace-transfer
    // primitive: re-upserting an id that belongs to another workspace would
    // silently move the row into this one.
    const upserts = pool.client.sql.filter((s) => s.includes("ON CONFLICT"));
    expect(upserts).toHaveLength(5);
    for (const sql of upserts) {
      expect(sql).toMatch(/WHERE tabdump_\w+\.workspace_id = EXCLUDED\.workspace_id/);
    }
  });

  it("keys the dependency upsert on the pair rather than an id", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.upsertDependency({ parentTabId: TAB, childTabId: TAB_B, createdAt: T0 });
    });
    const sql = pool.client.sql.find((s) => s.includes("tabdump_dependencies"))!;
    expect(sql).toContain("ON CONFLICT (parent_tab_id, child_tab_id)");
  });

  it("replaces collection membership wholesale and in the client's order", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.upsertCollection({ id: COLLECTION, name: "C", tabIds: [TAB_B, TAB], createdAt: T0, updatedAt: T0 });
    });

    const membership = pool.client.queries.filter((q) => q.text.includes("tabdump_collection_tabs"));
    expect(membership[0].text).toContain("DELETE FROM tabdump_collection_tabs WHERE collection_id = $1");
    // position carries the order the client holds, so tabIds round-trips.
    expect(membership[1].values).toEqual([WORKSPACE, COLLECTION, TAB_B, 0]);
    expect(membership[2].values).toEqual([WORKSPACE, COLLECTION, TAB, 1]);
  });
});

describe("deletes are tombstones", () => {
  beforeEach(() => {
    pool.client.willReturn([{ sync_counter: "4" }]);
    pool.client.willReturn([{ sync_counter: "5" }]);
  });

  it("sets deleted_at and a new version instead of removing the row", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.deleteTab(TAB, T0);
    });

    const sql = pool.client.sql.find((s) => s.startsWith("UPDATE tabdump_tabs SET deleted_at"))!;
    expect(sql).toContain("SET deleted_at = $1, sync_version = $2");
    expect(sql).toContain("WHERE workspace_id = $3 AND id = $4");
    // A real DELETE would make the deletion unreportable to other devices.
    expect(pool.client.sql.some((s) => s.startsWith("DELETE FROM tabdump_tabs"))).toBe(false);
  });

  /**
   * The workspace row is keyed by its own id, not by workspace_id, so it
   * cannot go through the shared tombstone helper. Ownership is already
   * settled by the FOR UPDATE lock this mutation was handed out under.
   */
  it("tombstones the workspace row itself without deleting it", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.deleteWorkspace(T0);
    });

    const sql = pool.client.sql.find((s) => s.startsWith("UPDATE tabdump_workspaces SET deleted_at"))!;
    expect(sql).toContain("SET deleted_at = $1, sync_version = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(pool.client.sql.some((s) => s.startsWith("DELETE FROM tabdump_workspaces"))).toBe(false);
  });

  /**
   * Its children are deliberately left alone: nothing can reach them once
   * listWorkspaces excludes the workspace, and tombstoning every row would
   * turn one deletion into a whole-workspace write — and flood the change
   * stream of any device that had not yet heard about it.
   */
  it("leaves the workspace's children alone when the workspace goes", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.deleteWorkspace(T0);
    });

    const childWrites = pool.client.sql.filter((s) =>
      /UPDATE tabdump_(tabs|sections|groups|collections|dependencies) SET deleted_at/.test(s)
    );
    expect(childWrites).toHaveLength(0);
  });

  it("scopes every tombstone to the workspace", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.deleteTab(TAB, T0);
      await m.deleteSection(SECTION, T0);
      await m.deleteGroup(SECTION, T0);
      await m.deleteCollection(COLLECTION, T0);
      await m.deleteDependency(TAB, TAB_B, T0);
    });

    const tombstones = pool.client.sql.filter((s) => s.includes("SET deleted_at"));
    expect(tombstones).toHaveLength(5);
    for (const sql of tombstones) expect(sql).toContain("WHERE workspace_id = $3");
  });

  it("identifies a dependency tombstone by its pair", async () => {
    await repo.mutateWorkspace(WORKSPACE, USER, {}, async (m) => {
      await m.deleteDependency(TAB, TAB_B, T0);
    });
    const sql = pool.client.sql.find((s) => s.includes("tabdump_dependencies"))!;
    expect(sql).toContain("parent_tab_id = $4 AND child_tab_id = $5");
  });
});

describe("row mapping", () => {
  it("converts BIGINT columns that arrive as strings", async () => {
    // `pg` returns BIGINT as a string because the type exceeds what a JS
    // number can hold in general. Epoch-ms does not, so Number() is lossless
    // — but the conversion has to actually happen.
    pool.willReturn([
      {
        id: WORKSPACE,
        name: "General",
        logo: null,
        created_at: "1700000000000",
        updated_at: "1700000000001",
        deleted_at: null,
        sync_version: "3",
      },
    ]);
    const [workspace] = await repo.listWorkspaces(USER);
    expect(workspace.createdAt).toBe(1_700_000_000_000);
    expect(workspace.updatedAt).toBe(1_700_000_000_001);
    expect(workspace).not.toHaveProperty("logo");
  });

  it("omits absent tab fields rather than returning nulls", async () => {
    pool.willReturn([{ sync_counter: "7" }]);
    pool.willReturn([
      {
        id: TAB,
        url: "https://example.com/a",
        title: null,
        notes: null,
        category: null,
        confidence: null,
        is_favorite: false,
        pinned: false,
        section_id: null,
        section_locked: false,
        organization_status: null,
        organization_reason: null,
        group_id: null,
        last_accessed_at: null,
        source: null,
        history_visit_count: null,
        history_last_visited_at: null,
        created_at: null,
        updated_at: null,
        deleted_at: null,
        sync_version: "3",
      },
    ]);

    const tabs = (await repo.getTabChangesSince(WORKSPACE, USER, "0", 10))!;
    // A tab with no timestamps is legitimate (it predates Phase 2); it must
    // come back absent, not as null or 0.
    expect(tabs[0]).toEqual({ id: TAB, url: "https://example.com/a" });
  });
});
