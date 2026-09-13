/**
 * An in-memory stand-in for the sync API, for multi-device tests.
 *
 * ## What this is and is not
 *
 * It implements the WIRE CONTRACT the routes in src/app/api/sync/ expose —
 * cursor semantics, the stale-base gate, tombstones, version-boundary
 * paging, ownership answering 404 — so that two real `SyncEngine` instances
 * can be driven against one shared server and their interaction observed.
 *
 * It is emphatically NOT a database. It proves nothing about transactions,
 * `FOR UPDATE`, foreign keys or cascade behaviour; those still have no real
 * Postgres to run against (see docs/sync-architecture.md). What it proves is
 * client-side: that two devices sharing an account converge, that conflicts
 * surface rather than resolving themselves, and that no path silently drops
 * an edit.
 *
 * Because a fake can drift from the thing it imitates, every rule below
 * names the production code it mirrors. The pairing is pinned by
 * `multi-device-server.test.ts`, which asserts this server's answers match
 * the real route contract for the cases both can reach.
 */

import type {
  CollectionSyncPayload,
  DependencySyncPayload,
  GroupSyncPayload,
  SectionSyncPayload,
  SyncChange,
  SyncEntityRef,
  SyncUpsert,
  TabSyncPayload,
  WorkspaceSyncPayload,
} from "./types";

/** Mirrors service.ts's SYNC_REQUEST_LIMITS.pullPageSize, overridable so a test can force paging cheaply. */
const DEFAULT_PAGE_SIZE = 500;

type EntityPayload =
  | WorkspaceSyncPayload
  | TabSyncPayload
  | SectionSyncPayload
  | GroupSyncPayload
  | CollectionSyncPayload
  | DependencySyncPayload;

/** One stored row. A tombstone keeps its payload so the row's version still orders it in the stream. */
type Record_ = {
  version: number;
  deletedAt?: number;
  payload: EntityPayload;
};

type StoredWorkspace = {
  userId: string;
  /** The per-workspace counter of schema.sql — the source of every version, never a global sequence. */
  counter: number;
  workspace: Record_;
  tabs: Map<string, Record_>;
  sections: Map<string, Record_>;
  groups: Map<string, Record_>;
  collections: Map<string, Record_>;
  /** Keyed by `${parentTabId}::${childTabId}` — the pair is the identity, exactly as in changes.ts. */
  dependencies: Map<string, Record_>;
};

export function dependencyKey(parentTabId: string, childTabId: string): string {
  return `${parentTabId}::${childTabId}`;
}

export type ServerCall = { url: string; method: string; body: Record<string, unknown> | null };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type FakeSyncServerOptions = {
  pageSize?: number;
  /** Server clock for tombstones, so a test is not at the mercy of Date.now. */
  now?: () => number;
};

export class FakeSyncServer {
  readonly calls: ServerCall[] = [];
  private readonly workspaces = new Map<string, StoredWorkspace>();
  private readonly pageSize: number;
  private readonly now: () => number;

  /** Who the session says is calling. A test flips this to act as another account, or null for anonymous. */
  currentUserId: string | null = null;

  /** Set to fail the next N requests with this status, to simulate transient network/server trouble. */
  private failNext: { count: number; status: number; body: unknown } | null = null;
  /** Set to drop the next N responses after applying them, simulating a lost reply. */
  private dropNext = 0;

  constructor(options: FakeSyncServerOptions = {}) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.now = options.now ?? (() => 1_700_000_000_000);
  }

  // ---- test controls ------------------------------------------------------

  failNextRequests(count: number, status: number, body: unknown = { error: "Server error." }): void {
    this.failNext = { count, status, body };
  }

  /** The response is computed and the write committed, then the reply is thrown away — a timeout after commit. */
  dropNextResponses(count: number): void {
    this.dropNext = count;
  }

  /** Tombstones a whole workspace, the way a deletion on another device would. */
  tombstoneWorkspace(workspaceId: string): void {
    const stored = this.workspaces.get(workspaceId);
    if (!stored) return;
    stored.counter += 1;
    stored.workspace = { ...stored.workspace, version: stored.counter, deletedAt: this.now() };
  }

  /** Current server-side cursor for a workspace, for asserting monotonicity. */
  cursorOf(workspaceId: string): string | null {
    const stored = this.workspaces.get(workspaceId);
    return stored ? String(stored.counter) : null;
  }

  /** The live (non-tombstoned) tab payload, for asserting what actually survived. */
  tabOf(workspaceId: string, tabId: string): TabSyncPayload | null {
    const record = this.workspaces.get(workspaceId)?.tabs.get(tabId);
    if (!record || record.deletedAt !== undefined) return null;
    return record.payload as TabSyncPayload;
  }

  collectionOf(workspaceId: string, collectionId: string): CollectionSyncPayload | null {
    const record = this.workspaces.get(workspaceId)?.collections.get(collectionId);
    if (!record || record.deletedAt !== undefined) return null;
    return record.payload as CollectionSyncPayload;
  }

  /** Live dependencies as `parent::child` keys, for asserting no logical duplicate appeared. */
  dependencyKeysOf(workspaceId: string): string[] {
    const stored = this.workspaces.get(workspaceId);
    if (!stored) return [];
    return [...stored.dependencies.entries()]
      .filter(([, record]) => record.deletedAt === undefined)
      .map(([key]) => key)
      .sort();
  }

  isTombstoned(workspaceId: string, type: keyof StoredWorkspace, id: string): boolean {
    const stored = this.workspaces.get(workspaceId);
    if (!stored) return false;
    const map = stored[type];
    if (!(map instanceof Map)) return false;
    return map.get(id)?.deletedAt !== undefined;
  }

  get pushes(): ServerCall[] {
    return this.calls.filter((c) => c.url.startsWith("/api/sync/push"));
  }
  get pulls(): ServerCall[] {
    return this.calls.filter((c) => c.url.startsWith("/api/sync/pull"));
  }

  // ---- the fetch seam -----------------------------------------------------

  get fetch() {
    return async (path: string, init: RequestInit = {}): Promise<Response> => {
      let body: Record<string, unknown> | null = null;
      if (typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      this.calls.push({ url: path, method: init.method ?? "GET", body });

      if (this.failNext && this.failNext.count > 0) {
        this.failNext.count--;
        const { status, body: failBody } = this.failNext;
        if (this.failNext.count === 0) this.failNext = null;
        return json(status, failBody);
      }

      // Identity comes from the "session" only — never from the body. A
      // forged userId in a payload is ignored here exactly as the real gate
      // ignores it (see http.ts).
      if (this.currentUserId === null) {
        return json(401, { error: "Sign in to continue." });
      }

      const response = this.route(path, init.method ?? "GET", body);
      if (this.dropNext > 0) {
        this.dropNext--;
        // The write already happened; the client just never hears about it.
        throw new TypeError("network error");
      }
      return response;
    };
  }

  private route(path: string, method: string, body: Record<string, unknown> | null): Response {
    if (path.startsWith("/api/sync/workspaces")) return this.discover();
    if (path.startsWith("/api/sync/initial") && method === "POST") return this.initial(body);
    if (path.startsWith("/api/sync/push") && method === "POST") return this.push(body);
    if (path.startsWith("/api/sync/pull")) return this.pull(path);
    return json(404, { error: "Not found." });
  }

  // ---- discovery ----------------------------------------------------------

  /** Metadata for the caller's own workspaces, mirroring /api/sync/workspaces. */
  private discover(): Response {
    const workspaces: WorkspaceSyncPayload[] = [];
    for (const stored of this.workspaces.values()) {
      // Someone else's workspaces are not merely hidden from the list —
      // they are not represented in it at all.
      if (stored.userId !== this.currentUserId) continue;
      if (stored.workspace.deletedAt !== undefined) continue;
      workspaces.push(stored.workspace.payload as WorkspaceSyncPayload);
    }
    return json(200, { workspaces, truncated: false });
  }

  // ---- initial ------------------------------------------------------------

  private initial(body: Record<string, unknown> | null): Response {
    const workspace = body?.workspace as WorkspaceSyncPayload | undefined;
    if (!workspace?.id) return json(400, { error: "That request isn't valid.", errors: ["workspace: required"] });

    const upserts = (Array.isArray(body?.upserts) ? body!.upserts : []) as SyncUpsert[];
    const knownCursor = typeof body?.knownCursor === "string" ? body.knownCursor : null;
    const existing = this.workspaces.get(workspace.id);

    if (existing) {
      // Another account's workspace is 404, not 409: a guessed id must not
      // become an existence oracle (http.ts's notFound()).
      if (existing.userId !== this.currentUserId) return json(404, { error: "Workspace not found." });
      // A retry proves itself by sending the cursor it last saw; anything
      // else is refused rather than overwriting (service.ts initial()).
      if (knownCursor === null || knownCursor !== String(existing.counter)) {
        // `already-exists`, not `conflict`: this account owns it and the
        // client's next move is adoption, not resolution.
        return json(409, {
          error: "That workspace is already on the server. Sync it to this device instead.",
          reason: "already-exists",
          serverCursor: String(existing.counter),
        });
      }
      const cursor = this.commit(existing, upserts, [], this.now());
      return json(200, { workspace, cursor, created: false });
    }

    const stored: StoredWorkspace = {
      userId: this.currentUserId!,
      counter: 0,
      workspace: { version: 0, payload: workspace },
      tabs: new Map(),
      sections: new Map(),
      groups: new Map(),
      collections: new Map(),
      dependencies: new Map(),
    };
    this.workspaces.set(workspace.id, stored);
    const cursor = this.commit(stored, [{ entityType: "workspace", entity: workspace }, ...upserts], [], this.now());
    return json(201, { workspace, cursor, created: true });
  }

  // ---- push ---------------------------------------------------------------

  private push(body: Record<string, unknown> | null): Response {
    const workspaceId = String(body?.workspaceId ?? "");
    const baseCursor = String(body?.baseCursor ?? "0");
    const upserts = (Array.isArray(body?.upserts) ? body!.upserts : []) as SyncUpsert[];
    const deletes = (Array.isArray(body?.deletes) ? body!.deletes : []) as SyncEntityRef[];

    const stored = this.workspaces.get(workspaceId);
    // Not yours and not there answer identically, on purpose.
    if (!stored || stored.userId !== this.currentUserId) return json(404, { error: "Workspace not found." });

    // The stale-base gate, mirroring repository.mutateWorkspace's strict
    // `expectedCursor !== current` comparison. Note what this implies: ANY
    // server-side movement makes a push stale, so same-entity contention
    // surfaces through the client's pull/apply path rather than through the
    // per-entity report below. That is the real contract, and the tests
    // assert it rather than a contract we wish were true.
    if (baseCursor !== String(stored.counter)) {
      return json(409, {
        error: "This workspace changed on the server. Pull the latest changes and try again.",
        reason: "stale-base",
        serverCursor: String(stored.counter),
      });
    }

    // The locked-section rule survives a matching cursor: it is about
    // intent, not staleness (service.ts detectConflicts).
    const conflicts = this.lockedSectionConflicts(stored, upserts, baseCursor);
    if (conflicts.length > 0) {
      return json(409, {
        error: "Some of those changes conflict with the server's copy.",
        reason: "conflict",
        serverCursor: baseCursor,
        conflicts,
      });
    }

    const deletedAt = this.now();
    const cursor = this.commit(stored, upserts, deletes, deletedAt);
    return json(200, { cursor, accepted: [] });
  }

  private lockedSectionConflicts(
    stored: StoredWorkspace,
    upserts: SyncUpsert[],
    baseCursor: string
  ): { entityType: string; entityId: string; baseCursor: string; serverCursor: string; reason: string }[] {
    const out: { entityType: string; entityId: string; baseCursor: string; serverCursor: string; reason: string }[] = [];
    for (const upsert of upserts) {
      if (upsert.entityType !== "tab") continue;
      const record = stored.tabs.get(upsert.entity.id);
      if (!record || record.deletedAt !== undefined) continue;
      const server = record.payload as TabSyncPayload;
      if (server.sectionLocked !== true) continue;
      const movesIt = (upsert.entity.sectionId ?? null) !== (server.sectionId ?? null);
      const isManual = upsert.entity.sectionLocked === true;
      if (movesIt && !isManual) {
        out.push({
          entityType: "tab",
          entityId: upsert.entity.id,
          baseCursor,
          serverCursor: String(record.version),
          reason: "locked-section",
        });
      }
    }
    return out;
  }

  /**
   * Applies a batch and stamps every row with ONE new version.
   *
   * The shared version is what makes a bulk change atomic in the stream —
   * mirrors mutateWorkspace bumping the counter once per transaction.
   */
  private commit(
    stored: StoredWorkspace,
    upserts: SyncUpsert[],
    deletes: SyncEntityRef[],
    deletedAt: number
  ): string {
    stored.counter += 1;
    const version = stored.counter;

    for (const upsert of upserts) {
      if (upsert.entityType === "workspace") {
        stored.workspace = { version, payload: upsert.entity };
        continue;
      }
      if (upsert.entityType === "dependency") {
        const key = dependencyKey(upsert.entity.parentTabId, upsert.entity.childTabId);
        // Keyed on the pair: re-creating the same logical dependency
        // replaces the row rather than adding a second one.
        stored.dependencies.set(key, { version, payload: upsert.entity });
        continue;
      }
      const map = this.mapFor(stored, upsert.entityType);
      map.set(upsert.entity.id, { version, payload: upsert.entity });
    }

    for (const ref of deletes) {
      if (ref.entityType === "workspace") {
        // Tombstones the workspace row and leaves its children, mirroring
        // service.ts's applyDeletes.
        stored.workspace = { ...stored.workspace, version, deletedAt };
        continue;
      }
      if (ref.entityType === "dependency") {
        const key = dependencyKey(ref.parentTabId, ref.childTabId);
        const existing = stored.dependencies.get(key);
        stored.dependencies.set(key, {
          version,
          deletedAt,
          payload: existing?.payload ?? { parentTabId: ref.parentTabId, childTabId: ref.childTabId, createdAt: deletedAt },
        });
        continue;
      }
      const map = this.mapFor(stored, ref.entityType);
      const existing = map.get(ref.entityId);
      // A tombstone is a row, not an absence — that is what lets another
      // device tell "deleted" from "never heard of".
      map.set(ref.entityId, {
        version,
        deletedAt,
        payload: existing?.payload ?? ({ id: ref.entityId } as EntityPayload),
      });
    }

    return String(version);
  }

  private mapFor(stored: StoredWorkspace, type: "tab" | "section" | "group" | "collection"): Map<string, Record_> {
    switch (type) {
      case "tab":
        return stored.tabs;
      case "section":
        return stored.sections;
      case "group":
        return stored.groups;
      case "collection":
        return stored.collections;
    }
  }

  // ---- pull ---------------------------------------------------------------

  private pull(path: string): Response {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const workspaceId = query.get("workspaceId") ?? "";
    const cursor = Number(query.get("cursor") ?? "0");

    const stored = this.workspaces.get(workspaceId);
    if (!stored || stored.userId !== this.currentUserId) return json(404, { error: "Workspace not found." });

    const collected: { version: number; change: SyncChange }[] = [];

    const add = (record: Record_, build: (cursorStr: string) => SyncChange) => {
      if (record.version <= cursor) return;
      collected.push({ version: record.version, change: build(String(record.version)) });
    };

    add(stored.workspace, (c) =>
      stored.workspace.deletedAt !== undefined
        ? ({
            operation: "delete",
            workspaceId,
            cursor: c,
            deletedAt: stored.workspace.deletedAt,
            entityType: "workspace",
            entityId: (stored.workspace.payload as WorkspaceSyncPayload).id,
          } as SyncChange)
        : ({
            operation: "upsert",
            workspaceId,
            cursor: c,
            entityType: "workspace",
            entityId: (stored.workspace.payload as WorkspaceSyncPayload).id,
            entity: stored.workspace.payload as WorkspaceSyncPayload,
          } as SyncChange)
    );

    const simple = [
      { map: stored.sections, entityType: "section" as const },
      { map: stored.groups, entityType: "group" as const },
      { map: stored.tabs, entityType: "tab" as const },
      { map: stored.collections, entityType: "collection" as const },
    ];
    for (const { map, entityType } of simple) {
      for (const [id, record] of map) {
        add(record, (c) =>
          record.deletedAt !== undefined
            ? ({
                operation: "delete",
                workspaceId,
                cursor: c,
                deletedAt: record.deletedAt,
                entityType,
                entityId: id,
              } as SyncChange)
            : ({
                operation: "upsert",
                workspaceId,
                cursor: c,
                entityType,
                entityId: id,
                entity: record.payload,
              } as SyncChange)
        );
      }
    }

    for (const [key, record] of stored.dependencies) {
      const [parentTabId, childTabId] = key.split("::");
      add(record, (c) =>
        record.deletedAt !== undefined
          ? ({
              operation: "delete",
              workspaceId,
              cursor: c,
              deletedAt: record.deletedAt,
              entityType: "dependency",
              parentTabId,
              childTabId,
            } as SyncChange)
          : ({
              operation: "upsert",
              workspaceId,
              cursor: c,
              entityType: "dependency",
              parentTabId,
              childTabId,
              entity: record.payload,
            } as SyncChange)
      );
    }

    collected.sort((a, b) => a.version - b.version);

    if (collected.length === 0) {
      return json(200, { workspaceId, changes: [], nextCursor: String(cursor), hasMore: false });
    }

    // Cut at a version boundary, never mid-transaction — changes.ts's rule,
    // including its "one oversized version wins over the page size" escape.
    let cut = collected.length;
    let hasMore = false;
    if (collected.length > this.pageSize) {
      const boundary = collected[this.pageSize].version;
      cut = collected.findIndex((entry) => entry.version === boundary);
      hasMore = true;
      if (cut === 0) {
        cut = collected.findIndex((entry) => entry.version !== boundary);
        if (cut === -1) cut = collected.length;
        hasMore = cut < collected.length;
      }
    }

    const page = collected.slice(0, cut);
    const nextCursor = page.length > 0 ? String(page[page.length - 1].version) : String(cursor);
    return json(200, { workspaceId, changes: page.map((e) => e.change), nextCursor, hasMore });
  }
}
