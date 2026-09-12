import "server-only";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  CollectionSyncPayload,
  DependencySyncPayload,
  GroupSyncPayload,
  SectionSyncPayload,
  SyncCursor,
  TabSyncPayload,
  WorkspaceSyncPayload,
} from "./types";

/**
 * Server-side data access for the workspace sync schema (./schema.sql).
 *
 * Nothing in the running application calls this yet. It exists so the
 * contract in ./types.ts is backed by something executable and testable, and
 * so a later phase adds route handlers rather than inventing SQL inside
 * them. Only the operations needed to establish and test the contract are
 * here — this is not the sync service.
 *
 *
 * ## Ownership
 *
 * Every method takes `userId` and every statement that touches workspace
 * data is constrained by it. There is no method that accepts a workspace id
 * alone, because such a method is exactly the accident that leaks another
 * user's data through a guessed id.
 *
 * `userId` must come from the session (src/lib/auth/guard.ts's requireUser)
 * and never from a request body. No payload type in ./types.ts carries an
 * owner field, so there is nothing for a caller to pass by mistake.
 *
 * Child entities are never checked against `userId` directly. They are
 * reached only through a workspace this user owns, and the schema's
 * composite foreign keys make a child of another workspace unrepresentable
 * — so the ownership check happens once, at the workspace, and the database
 * guarantees the rest.
 *
 *
 * ## Transactions
 *
 * `mutateWorkspace` runs the caller's writes inside one transaction that
 * begins by claiming a version number under a row lock on the workspace.
 * Two properties follow, and both matter for sync:
 *
 *  - Every row written by one call gets the SAME sync_version, so a bulk
 *    operation (organize, move 20 tabs, import a workspace) appears in the
 *    change stream as one step. A client can never observe half of it.
 *  - Because the number is taken under `FOR UPDATE`, concurrent mutations of
 *    the same workspace serialize, so version order equals commit order.
 *    That is the property a cursor depends on and the reason this is not a
 *    global Postgres SEQUENCE — see the long note in schema.sql.
 */

/** Epoch-ms and version columns arrive from `pg` as strings because they are BIGINT. Same reasoning as src/lib/auth/store/postgres.ts. */
function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : toNumber(value);
}

function toOptional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/** Drops undefined-valued keys so an absent optional stays absent. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

type WorkspaceRow = {
  id: string;
  name: string;
  logo: string | null;
  created_at: string | number;
  updated_at: string | number;
  deleted_at: string | number | null;
  sync_version: string | number;
};

type TabRow = {
  id: string;
  url: string;
  title: string | null;
  notes: string | null;
  category: string | null;
  confidence: number | null;
  is_favorite: boolean;
  pinned: boolean;
  section_id: string | null;
  section_locked: boolean;
  organization_status: string | null;
  organization_reason: string | null;
  group_id: string | null;
  last_accessed_at: string | number | null;
  source: string | null;
  history_visit_count: number | null;
  history_last_visited_at: string | number | null;
  created_at: string | number | null;
  updated_at: string | number | null;
  deleted_at: string | number | null;
  sync_version: string | number;
};

const WORKSPACE_COLUMNS = "id, name, logo, created_at, updated_at, deleted_at, sync_version";
const TAB_COLUMNS =
  "id, url, title, notes, category, confidence, is_favorite, pinned, section_id, section_locked, " +
  "organization_status, organization_reason, group_id, last_accessed_at, source, history_visit_count, " +
  "history_last_visited_at, created_at, updated_at, deleted_at, sync_version";

function toWorkspace(row: WorkspaceRow): WorkspaceSyncPayload {
  return compact({
    id: row.id,
    name: row.name,
    logo: toOptional(row.logo),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  });
}

function toTab(row: TabRow): TabSyncPayload {
  return compact({
    id: row.id,
    url: row.url,
    title: toOptional(row.title),
    notes: toOptional(row.notes),
    category: toOptional(row.category),
    confidence: toOptional(row.confidence),
    isFavorite: row.is_favorite || undefined,
    pinned: row.pinned || undefined,
    sectionId: toOptional(row.section_id),
    sectionLocked: row.section_locked || undefined,
    organizationStatus: toOptional(row.organization_status) as TabSyncPayload["organizationStatus"],
    organizationReason: toOptional(row.organization_reason),
    groupId: toOptional(row.group_id),
    lastAccessedAt: toOptionalNumber(row.last_accessed_at),
    source: toOptional(row.source) as TabSyncPayload["source"],
    historyVisitCount: toOptional(row.history_visit_count),
    historyLastVisitedAt: toOptionalNumber(row.history_last_visited_at),
    createdAt: toOptionalNumber(row.created_at),
    updatedAt: toOptionalNumber(row.updated_at),
  });
}

/**
 * The handle a caller gets inside `mutateWorkspace`. Every write it exposes
 * is already bound to one workspace and one version, so a caller cannot
 * write into a different workspace or stamp a different version by accident.
 */
export type WorkspaceMutation = {
  readonly workspaceId: string;
  /** The version every row written through this handle receives. */
  readonly version: bigint;
  upsertTab(tab: TabSyncPayload): Promise<void>;
  upsertSection(section: SectionSyncPayload): Promise<void>;
  upsertGroup(group: GroupSyncPayload): Promise<void>;
  upsertCollection(collection: CollectionSyncPayload): Promise<void>;
  upsertDependency(dependency: DependencySyncPayload): Promise<void>;
  /** Tombstones rather than deletes. `entityType` "dependency" uses the pair. */
  deleteTab(id: string, deletedAt: number): Promise<void>;
  deleteSection(id: string, deletedAt: number): Promise<void>;
  deleteGroup(id: string, deletedAt: number): Promise<void>;
  deleteCollection(id: string, deletedAt: number): Promise<void>;
  deleteDependency(parentTabId: string, childTabId: string, deletedAt: number): Promise<void>;
};

export class SyncRepository {
  constructor(private readonly pool: Pool) {}

  private async query<R extends QueryResultRow>(text: string, values: unknown[]): Promise<R[]> {
    const result = await this.pool.query<R>(text, values);
    return result.rows;
  }

  /**
   * Every workspace this user owns, tombstones excluded.
   *
   * Served by tabdump_workspaces_owner_idx.
   */
  async listWorkspaces(userId: string): Promise<WorkspaceSyncPayload[]> {
    const rows = await this.query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM tabdump_workspaces
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY created_at`,
      [userId]
    );
    return rows.map(toWorkspace);
  }

  /**
   * One workspace, or null.
   *
   * `user_id = $2` is the authorization: a workspace belonging to someone
   * else is indistinguishable from one that does not exist, so a guessed id
   * reveals nothing — not even whether it is real.
   */
  async getWorkspace(workspaceId: string, userId: string): Promise<WorkspaceSyncPayload | null> {
    const rows = await this.query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM tabdump_workspaces
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [workspaceId, userId]
    );
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  /** The workspace's current cursor, or null when the user does not own it. */
  async getCursor(workspaceId: string, userId: string): Promise<SyncCursor | null> {
    const rows = await this.query<{ sync_counter: string | number }>(
      `SELECT sync_counter FROM tabdump_workspaces WHERE id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    return rows[0] ? String(rows[0].sync_counter) : null;
  }

  /**
   * Creates a workspace owned by `userId`.
   *
   * The id comes from the client and is stored verbatim — no remapping, no
   * server-generated identity. That is what lets a workspace created offline
   * upload later as itself.
   */
  async createWorkspace(workspace: WorkspaceSyncPayload, userId: string): Promise<SyncCursor> {
    const rows = await this.query<{ sync_counter: string | number }>(
      `INSERT INTO tabdump_workspaces
         (id, user_id, name, logo, created_at, updated_at, sync_version, sync_counter)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1)
       RETURNING sync_counter`,
      [workspace.id, userId, workspace.name, workspace.logo ?? null, workspace.createdAt, workspace.updatedAt]
    );
    return String(rows[0].sync_counter);
  }

  /**
   * Runs `write` against one workspace inside a single transaction.
   *
   * Returns the cursor the mutation produced, or null when this user does
   * not own the workspace — in which case nothing ran at all.
   *
   * `expectedCursor` is the conflict check: when given, the mutation is
   * refused unless the workspace is still where the client thought it was.
   * Detecting the conflict is this phase's job; deciding what to do about it
   * is not (see SyncConflict in ./types.ts).
   */
  async mutateWorkspace(
    workspaceId: string,
    userId: string,
    options: { expectedCursor?: SyncCursor },
    write: (mutation: WorkspaceMutation) => Promise<void>
  ): Promise<{ ok: true; cursor: SyncCursor } | { ok: false; reason: "not-found" | "conflict"; cursor?: SyncCursor }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // FOR UPDATE is the whole ordering guarantee: it serializes concurrent
      // mutations of this workspace, so the version handed out below is
      // assigned in commit order. Combined with `user_id = $2`, it is also
      // the ownership gate — a workspace this user does not own returns no
      // row and the transaction ends having touched nothing.
      const locked = await client.query<{ sync_counter: string | number }>(
        `SELECT sync_counter FROM tabdump_workspaces WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [workspaceId, userId]
      );
      if (!locked.rows[0]) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "not-found" };
      }

      const current = String(locked.rows[0].sync_counter);
      if (options.expectedCursor !== undefined && options.expectedCursor !== current) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "conflict", cursor: current };
      }

      const bumped = await client.query<{ sync_counter: string | number }>(
        `UPDATE tabdump_workspaces SET sync_counter = sync_counter + 1 WHERE id = $1 RETURNING sync_counter`,
        [workspaceId]
      );
      const version = BigInt(String(bumped.rows[0].sync_counter));

      await write(createMutation(client, workspaceId, version));

      await client.query("COMMIT");
      return { ok: true, cursor: version.toString() };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Everything in this workspace with a version above `cursor`, in version
   * order — the read half of incremental sync.
   *
   * Tombstones are included deliberately: a client learns about a deletion
   * because the row is still there with `deleted_at` set. If deletions were
   * real DELETEs, this query could never report them and a deleted tab would
   * live forever on every other device.
   *
   * Served by the `(workspace_id, sync_version)` index on each table.
   */
  async getTabChangesSince(
    workspaceId: string,
    userId: string,
    cursor: SyncCursor,
    limit: number
  ): Promise<TabSyncPayload[] | null> {
    const owns = await this.getCursor(workspaceId, userId);
    if (owns === null) return null;

    const rows = await this.query<TabRow>(
      `SELECT ${TAB_COLUMNS} FROM tabdump_tabs
        WHERE workspace_id = $1 AND sync_version > $2
        ORDER BY sync_version
        LIMIT $3`,
      [workspaceId, cursor, limit]
    );
    return rows.map(toTab);
  }
}

function createMutation(client: PoolClient, workspaceId: string, version: bigint): WorkspaceMutation {
  const v = version.toString();

  /**
   * Upserts share one shape: ON CONFLICT DO UPDATE keyed on the entity's
   * identity, with `workspace_id` in the WHERE so a row cannot be moved into
   * this workspace by re-upserting an id that belongs to another one. Without
   * that predicate, an upsert would be a workspace-transfer primitive.
   */
  const upsert = async (text: string, values: unknown[]) => {
    await client.query(text, values);
  };

  const tombstone = async (table: string, predicate: string, values: unknown[]) => {
    await client.query(
      `UPDATE ${table} SET deleted_at = $1, sync_version = $2 WHERE workspace_id = $3 AND ${predicate}`,
      values
    );
  };

  return {
    workspaceId,
    version,

    async upsertTab(tab) {
      await upsert(
        `INSERT INTO tabdump_tabs
           (id, workspace_id, url, title, notes, category, confidence, is_favorite, pinned,
            section_id, section_locked, organization_status, organization_reason, group_id,
            last_accessed_at, source, history_visit_count, history_last_visited_at,
            created_at, updated_at, deleted_at, sync_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NULL, $21)
         ON CONFLICT (id) DO UPDATE SET
           url = EXCLUDED.url, title = EXCLUDED.title, notes = EXCLUDED.notes,
           category = EXCLUDED.category, confidence = EXCLUDED.confidence,
           is_favorite = EXCLUDED.is_favorite, pinned = EXCLUDED.pinned,
           section_id = EXCLUDED.section_id, section_locked = EXCLUDED.section_locked,
           organization_status = EXCLUDED.organization_status,
           organization_reason = EXCLUDED.organization_reason,
           group_id = EXCLUDED.group_id, last_accessed_at = EXCLUDED.last_accessed_at,
           source = EXCLUDED.source, history_visit_count = EXCLUDED.history_visit_count,
           history_last_visited_at = EXCLUDED.history_last_visited_at,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL, sync_version = EXCLUDED.sync_version
         WHERE tabdump_tabs.workspace_id = EXCLUDED.workspace_id`,
        [
          tab.id,
          workspaceId,
          tab.url,
          tab.title ?? null,
          tab.notes ?? null,
          tab.category ?? null,
          tab.confidence ?? null,
          tab.isFavorite ?? false,
          tab.pinned ?? false,
          tab.sectionId ?? null,
          tab.sectionLocked ?? false,
          tab.organizationStatus ?? null,
          tab.organizationReason ?? null,
          tab.groupId ?? null,
          tab.lastAccessedAt ?? null,
          tab.source ?? null,
          tab.historyVisitCount ?? null,
          tab.historyLastVisitedAt ?? null,
          tab.createdAt ?? null,
          tab.updatedAt ?? null,
          v,
        ]
      );
    },

    async upsertSection(section) {
      await upsert(
        `INSERT INTO tabdump_sections
           (id, workspace_id, parent_id, name, source, created_at, updated_at, deleted_at, sync_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
         ON CONFLICT (id) DO UPDATE SET
           parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, source = EXCLUDED.source,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL, sync_version = EXCLUDED.sync_version
         WHERE tabdump_sections.workspace_id = EXCLUDED.workspace_id`,
        [section.id, workspaceId, section.parentId, section.name, section.source, section.createdAt, section.updatedAt, v]
      );
    },

    async upsertGroup(group) {
      await upsert(
        `INSERT INTO tabdump_groups
           (id, workspace_id, name, created_at, updated_at, deleted_at, sync_version)
         VALUES ($1, $2, $3, $4, $5, NULL, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL, sync_version = EXCLUDED.sync_version
         WHERE tabdump_groups.workspace_id = EXCLUDED.workspace_id`,
        [group.id, workspaceId, group.name, group.createdAt, group.updatedAt, v]
      );
    },

    /**
     * Membership is replaced wholesale rather than diffed: the client models
     * it as an ordered array on the collection, so "the new list" is the only
     * thing it can express. Delete-then-insert inside the transaction keeps
     * `position` dense and in the client's order.
     */
    async upsertCollection(collection) {
      await upsert(
        `INSERT INTO tabdump_collections
           (id, workspace_id, name, created_at, updated_at, deleted_at, sync_version)
         VALUES ($1, $2, $3, $4, $5, NULL, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL, sync_version = EXCLUDED.sync_version
         WHERE tabdump_collections.workspace_id = EXCLUDED.workspace_id`,
        [collection.id, workspaceId, collection.name, collection.createdAt, collection.updatedAt, v]
      );

      await client.query(`DELETE FROM tabdump_collection_tabs WHERE collection_id = $1`, [collection.id]);
      for (const [position, tabId] of collection.tabIds.entries()) {
        await client.query(
          `INSERT INTO tabdump_collection_tabs (workspace_id, collection_id, tab_id, position)
           VALUES ($1, $2, $3, $4)`,
          [workspaceId, collection.id, tabId, position]
        );
      }
    },

    async upsertDependency(dependency) {
      await upsert(
        `INSERT INTO tabdump_dependencies
           (workspace_id, parent_tab_id, child_tab_id, type, created_at, updated_at, deleted_at, sync_version)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)
         ON CONFLICT (parent_tab_id, child_tab_id) DO UPDATE SET
           type = EXCLUDED.type, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL, sync_version = EXCLUDED.sync_version
         WHERE tabdump_dependencies.workspace_id = EXCLUDED.workspace_id`,
        [
          workspaceId,
          dependency.parentTabId,
          dependency.childTabId,
          dependency.type ?? null,
          dependency.createdAt,
          dependency.updatedAt ?? null,
          v,
        ]
      );
    },

    async deleteTab(id, deletedAt) {
      await tombstone("tabdump_tabs", "id = $4", [deletedAt, v, workspaceId, id]);
    },
    async deleteSection(id, deletedAt) {
      await tombstone("tabdump_sections", "id = $4", [deletedAt, v, workspaceId, id]);
    },
    async deleteGroup(id, deletedAt) {
      await tombstone("tabdump_groups", "id = $4", [deletedAt, v, workspaceId, id]);
    },
    async deleteCollection(id, deletedAt) {
      await tombstone("tabdump_collections", "id = $4", [deletedAt, v, workspaceId, id]);
    },
    async deleteDependency(parentTabId, childTabId, deletedAt) {
      await tombstone("tabdump_dependencies", "parent_tab_id = $4 AND child_tab_id = $5", [
        deletedAt,
        v,
        workspaceId,
        parentTabId,
        childTabId,
      ]);
    },
  };
}
