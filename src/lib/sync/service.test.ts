import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SyncService } from "./service";
import type { EntityVersions } from "./changes";
import type { SyncEntityRef, SyncUpsert } from "./types";

/**
 * Conflict detection and transactional behaviour, against a recording fake.
 *
 * There is no Postgres here (the limit recorded in
 * src/lib/auth/store/postgres.test.ts still holds), so these do not prove
 * that FOR UPDATE serializes anything or that a transaction rolls back in
 * the database. What they do prove is the decision layer: which incoming
 * writes are refused, which are accepted, and that a refusal reaches the
 * database as a rollback with no writes rather than as a partial apply.
 */

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const TAB = "22222222-2222-4222-8222-222222222222";
const SECTION_A = "44444444-4444-4444-8444-444444444444";
const SECTION_B = "55555555-5555-4555-8555-555555555555";
const T0 = 1_700_000_000_000;

function emptyVersions(): EntityVersions {
  return {
    workspace: BigInt(10),
    tabs: new Map(),
    sections: new Map(),
    groups: new Map(),
    collections: new Map(),
    dependencies: new Map(),
  };
}

/**
 * A pool whose client records every statement and answers the two queries
 * mutateWorkspace makes (the FOR UPDATE lock, then the counter bump).
 */
class FakePool {
  statements: string[] = [];
  released = 0;
  /** What the workspace's counter currently is; also decides ownership when null. */
  counter: string | null = "10";
  versions: EntityVersions = emptyVersions();

  private readonly self = this;

  async connect() {
    const pool = this.self;
    return {
      async query(text: string, values: unknown[] = []) {
        pool.statements.push(text.replace(/\s+/g, " ").trim());
        if (/FOR UPDATE/.test(text)) {
          return { rows: pool.counter === null ? [] : [{ sync_counter: pool.counter }] };
        }
        if (/SET sync_counter = sync_counter \+ 1/.test(text)) {
          const next = String(Number(pool.counter) + 1);
          return { rows: [{ sync_counter: next }] };
        }
        void values;
        return { rows: [] };
      },
      release() {
        pool.released++;
      },
    };
  }

  async query(text: string, values: unknown[] = []) {
    this.statements.push(text.replace(/\s+/g, " ").trim());
    void values;
    if (/SELECT sync_counter/.test(text)) {
      return { rows: this.counter === null ? [] : [{ sync_counter: this.counter }] };
    }
    if (/INSERT INTO tabdump_workspaces/.test(text)) {
      // Mirrors the real statement, which inserts with sync_counter = 1 and
      // RETURNs it — and makes the workspace exist for the mutation that follows.
      this.counter = "1";
      return { rows: [{ sync_counter: "1" }] };
    }
    return { rows: [] };
  }

  /** Statements that actually wrote entity rows. */
  get entityWrites(): string[] {
    return this.statements.filter((s) => /INSERT INTO tabdump_(tabs|sections|groups|collections|dependencies)/.test(s) || /SET deleted_at/.test(s));
  }
}

let pool: FakePool;
let service: SyncService;

/** Patches the mutation handle's version read, which normally hits the database. */
function withVersions(versions: EntityVersions): void {
  pool.versions = versions;
}

beforeEach(async () => {
  pool = new FakePool();
  service = new SyncService(pool as unknown as Pool);
  // readEntityVersions runs real SQL against the fake, which returns no
  // rows — so every map comes back empty unless a test overrides it. The
  // override goes through the module the mutation handle calls.
  const changes = await import("./changes");
  Object.defineProperty(changes, "readEntityVersions", {
    configurable: true,
    value: async () => pool.versions,
  });
});

function tabUpsert(over: Record<string, unknown> = {}): SyncUpsert {
  return { entityType: "tab", entity: { id: TAB, url: "https://example.com/a", ...over } } as SyncUpsert;
}

describe("push refuses before it writes", () => {
  it("reports not-found for a workspace the user does not own", async () => {
    pool.counter = null;
    const result = await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(pool.entityWrites).toHaveLength(0);
  });

  it("reports a stale base without writing", async () => {
    pool.counter = "12";
    const result = await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale-base");
    expect(pool.entityWrites).toHaveLength(0);
    expect(pool.statements).toContain("ROLLBACK");
  });

  it("accepts a push whose base matches", async () => {
    const result = await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursor).toBe("11");
    expect(pool.statements).toContain("COMMIT");
  });
});

describe("per-entity conflict detection", () => {
  it("refuses a tab that changed since the client's base", async () => {
    const versions = emptyVersions();
    versions.tabs.set(TAB, { version: BigInt(12), sectionLocked: false, sectionId: null });
    withVersions(versions);

    const result = await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      entityType: "tab",
      entityId: TAB,
      serverCursor: "12",
      reason: "changed-since-base",
    });
    // Nothing was written, and the transaction rolled back.
    expect(pool.entityWrites).toHaveLength(0);
    expect(pool.statements).toContain("ROLLBACK");
    expect(pool.statements).not.toContain("COMMIT");
  });

  it("accepts a tab whose server version is at or below the base", async () => {
    const versions = emptyVersions();
    versions.tabs.set(TAB, { version: BigInt(10), sectionLocked: false, sectionId: null });
    withVersions(versions);

    const result = await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(result.ok).toBe(true);
  });

  it("does not make two devices editing different tabs conflict", async () => {
    // The reason detection is per-entity rather than per-workspace: an
    // unrelated tab moving forward must not block this one.
    const other = "66666666-6666-4666-8666-666666666666";
    const versions = emptyVersions();
    versions.tabs.set(other, { version: BigInt(99), sectionLocked: false, sectionId: null });
    withVersions(versions);

    const result = await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(result.ok).toBe(true);
  });

  it("refuses a delete of something that changed since the base", async () => {
    const versions = emptyVersions();
    versions.tabs.set(TAB, { version: BigInt(15), sectionLocked: false, sectionId: null });
    withVersions(versions);

    const deletes: SyncEntityRef[] = [{ entityType: "tab", entityId: TAB }];
    const result = await service.push(WS, USER, "10", [], deletes, T0);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
    expect(result.conflicts[0].entityId).toBe(TAB);
  });
});

describe("manual organization is not overridden by automatic placement", () => {
  it("refuses an unlocked write that would move a tab a human locked", async () => {
    const versions = emptyVersions();
    versions.tabs.set(TAB, { version: BigInt(10), sectionLocked: true, sectionId: SECTION_A });
    withVersions(versions);

    // An AI/automatic placement from another device: it moves the tab and
    // does not claim to be a manual move.
    const result = await service.push(WS, USER, "10", [tabUpsert({ sectionId: SECTION_B })], [], T0);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
    expect(result.conflicts[0].reason).toBe("locked-section");
    expect(pool.entityWrites).toHaveLength(0);
  });

  it("accepts a genuine manual move of a locked tab", async () => {
    const versions = emptyVersions();
    versions.tabs.set(TAB, { version: BigInt(10), sectionLocked: true, sectionId: SECTION_A });
    withVersions(versions);

    // The human changed their mind; the write says so by carrying the lock.
    const result = await service.push(
      WS,
      USER,
      "10",
      [tabUpsert({ sectionId: SECTION_B, sectionLocked: true })],
      [],
      T0
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an unlocked write that leaves a locked tab where it is", async () => {
    const versions = emptyVersions();
    versions.tabs.set(TAB, { version: BigInt(10), sectionLocked: true, sectionId: SECTION_A });
    withVersions(versions);

    // Editing the title of a locked tab is not an attempt to reorganize it.
    const result = await service.push(
      WS,
      USER,
      "10",
      [tabUpsert({ sectionId: SECTION_A, title: "Renamed" })],
      [],
      T0
    );
    expect(result.ok).toBe(true);
  });
});

describe("atomicity", () => {
  it("writes every accepted change inside one transaction", async () => {
    const upserts: SyncUpsert[] = [
      { entityType: "section", entity: { id: SECTION_A, parentId: null, name: "S", source: "ai", createdAt: T0, updatedAt: T0 } },
      tabUpsert(),
    ];
    await service.push(WS, USER, "10", upserts, [], T0);

    const begin = pool.statements.indexOf("BEGIN");
    const commit = pool.statements.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    for (const write of pool.entityWrites) {
      const at = pool.statements.indexOf(write);
      expect(at).toBeGreaterThan(begin);
      expect(at).toBeLessThan(commit);
    }
  });

  it("returns the accepted changes so the client need not guess", async () => {
    const result = await service.push(WS, USER, "10", [tabUpsert()], [{ entityType: "tab", entityId: TAB }], T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toHaveLength(2);
    // Every accepted change carries the new cursor, so one push is one
    // coherent workspace version.
    for (const change of result.accepted) expect(change.cursor).toBe("11");
    expect(result.accepted.find((c) => c.operation === "delete")).toMatchObject({ deletedAt: T0 });
  });

  it("releases the connection on every path", async () => {
    await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    pool.counter = "99";
    await service.push(WS, USER, "10", [tabUpsert()], [], T0);
    expect(pool.released).toBe(2);
  });
});

describe("multi-client scenario", () => {
  it("does not let B's push based on an old cursor overwrite A's", async () => {
    // Both clients start at cursor 10. A pushes first and the workspace
    // advances to 11.
    const a = await service.push(WS, USER, "10", [tabUpsert({ title: "A" })], [], T0);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.cursor).toBe("11");

    // B still believes it is at 10.
    pool.counter = "11";
    const b = await service.push(WS, USER, "10", [tabUpsert({ title: "B" })], [], T0);

    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe("stale-base");
    // B's title never reached the database, so A's write stands.
    expect(pool.entityWrites.filter((s) => s.includes("INSERT INTO tabdump_tabs"))).toHaveLength(1);
  });
});

describe("initial sync", () => {
  it("creates a workspace that does not exist yet", async () => {
    pool.counter = null;
    const result = await service.initial(
      { workspace: { id: WS, name: "W", createdAt: T0, updatedAt: T0 }, upserts: [tabUpsert()] },
      USER,
      null
    );
    // createWorkspace runs, then the entities are written in one mutation.
    expect(pool.statements.some((s) => s.includes("INSERT INTO tabdump_workspaces"))).toBe(true);
    void result;
  });

  it("refuses an existing workspace when the client cannot prove it has seen it", async () => {
    pool.counter = "7";
    const result = await service.initial(
      { workspace: { id: WS, name: "W", createdAt: T0, updatedAt: T0 }, upserts: [] },
      USER,
      null
    );
    expect(result).toEqual({ ok: false, reason: "conflict", serverCursor: "7" });
    // Nothing overwritten: the server's copy stands and the client keeps its own.
    expect(pool.entityWrites).toHaveLength(0);
  });

  it("treats a retry carrying the known cursor as an idempotent update", async () => {
    pool.counter = "7";
    const result = await service.initial(
      { workspace: { id: WS, name: "W", createdAt: T0, updatedAt: T0 }, upserts: [tabUpsert()] },
      USER,
      "7"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    // The same client-generated ids are written again, so no duplicate rows
    // can appear however many times this runs.
    expect(pool.statements.some((s) => s.includes("ON CONFLICT (id) DO UPDATE"))).toBe(true);
  });

  it("refuses a workspace larger than the limit before touching the database", async () => {
    const upserts = Array.from({ length: 10_001 }, () => tabUpsert());
    const result = await service.initial(
      { workspace: { id: WS, name: "W", createdAt: T0, updatedAt: T0 }, upserts },
      USER,
      null
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
    expect(pool.statements).toHaveLength(0);
  });
});
