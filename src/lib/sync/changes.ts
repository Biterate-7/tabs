import "server-only";
import type { PoolClient } from "pg";
import type {
  CollectionSyncPayload,
  DependencySyncPayload,
  GroupSyncPayload,
  SectionSyncPayload,
  SyncChange,
  SyncCursor,
  TabSyncPayload,
  WorkspaceSyncPayload,
} from "./types";

/**
 * Reading a workspace's change stream, and checking whether an incoming
 * write is based on what the server currently holds.
 *
 * Split out of repository.ts because it is the read/conflict half rather
 * than the write half, and because every query here is driven by one index
 * — `(workspace_id, sync_version)` — which is easier to keep honest in one
 * place.
 *
 *
 * ## What a change is
 *
 * One row whose `sync_version` is above the caller's cursor. A row with
 * `deleted_at` set becomes a "delete" change rather than being filtered out:
 * that is the entire reason tombstones exist. Filtering them here would make
 * deletion unsynchronizable and is the single easiest way to reintroduce the
 * "deleted tab comes back on the other device" bug.
 *
 *
 * ## Ordering and paging
 *
 * Everything is ordered by `sync_version`, which Phase 3 assigns from a
 * counter taken under a row lock on the workspace — so version order is
 * commit order and a cursor can rely on it. A page is cut at a version
 * BOUNDARY, never mid-version: every row written by one transaction shares a
 * version, and returning half of them would hand a client exactly the
 * partial bulk operation the transaction existed to prevent.
 */

type Row = Record<string, unknown>;

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : toNumber(value);
}

function toOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const TAB_COLUMNS =
  "id, url, title, notes, category, confidence, is_favorite, pinned, section_id, section_locked, " +
  "organization_status, organization_reason, group_id, last_accessed_at, source, history_visit_count, " +
  "history_last_visited_at, created_at, updated_at, deleted_at, sync_version";

function rowToTab(row: Row): TabSyncPayload {
  return compact({
    id: String(row.id),
    url: String(row.url),
    title: toOptionalString(row.title),
    notes: toOptionalString(row.notes),
    category: toOptionalString(row.category),
    confidence: row.confidence === null || row.confidence === undefined ? undefined : Number(row.confidence),
    isFavorite: row.is_favorite === true ? true : undefined,
    pinned: row.pinned === true ? true : undefined,
    sectionId: toOptionalString(row.section_id),
    sectionLocked: row.section_locked === true ? true : undefined,
    organizationStatus: toOptionalString(row.organization_status) as TabSyncPayload["organizationStatus"],
    organizationReason: toOptionalString(row.organization_reason),
    groupId: toOptionalString(row.group_id),
    lastAccessedAt: toOptionalNumber(row.last_accessed_at),
    source: toOptionalString(row.source) as TabSyncPayload["source"],
    historyVisitCount:
      row.history_visit_count === null || row.history_visit_count === undefined
        ? undefined
        : Number(row.history_visit_count),
    historyLastVisitedAt: toOptionalNumber(row.history_last_visited_at),
    createdAt: toOptionalNumber(row.created_at),
    updatedAt: toOptionalNumber(row.updated_at),
  });
}

function rowToWorkspace(row: Row): WorkspaceSyncPayload {
  return compact({
    id: String(row.id),
    name: String(row.name),
    logo: toOptionalString(row.logo),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  });
}

function rowToSection(row: Row): SectionSyncPayload {
  return {
    id: String(row.id),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    name: String(row.name),
    source: String(row.source) as SectionSyncPayload["source"],
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

function rowToGroup(row: Row): GroupSyncPayload {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

function rowToDependency(row: Row): DependencySyncPayload {
  return compact({
    parentTabId: String(row.parent_tab_id),
    childTabId: String(row.child_tab_id),
    type: toOptionalString(row.type) as DependencySyncPayload["type"],
    createdAt: toNumber(row.created_at),
    updatedAt: toOptionalNumber(row.updated_at),
  });
}

/**
 * Which slice of the change stream to read.
 *
 * `since` is the ordinary paged read. `version` reads ONE version in full
 * with no row limit, which is how a transaction larger than a page is
 * delivered — see readChangesSince.
 */
type Selection =
  | { kind: "since"; cursor: SyncCursor; limit: number }
  | { kind: "version"; version: bigint };

async function collectChanges(
  client: PoolClient,
  workspaceId: string,
  selection: Selection
): Promise<{ version: bigint; change: SyncChange }[]> {
  const collected: { version: bigint; change: SyncChange }[] = [];

  // Both values come from this file's own closed union, never from a caller
  // or a request — the comparison is a fixed operator and the bound is a
  // number this module chose. Every user-controlled value below is still
  // passed as a parameter.
  const op = selection.kind === "since" ? ">" : "=";
  const bound = selection.kind === "since" ? selection.cursor : selection.version.toString();
  const limitSql = selection.kind === "since" ? " LIMIT $3" : "";
  const limitParams = selection.kind === "since" ? [selection.limit + 1] : [];

  const push = (row: Row, build: () => SyncChange) => {
    collected.push({ version: BigInt(String(row.sync_version)), change: build() });
  };

  const workspaceRows = await client.query<Row>(
    `SELECT id, name, logo, created_at, updated_at, deleted_at, sync_version
       FROM tabdump_workspaces
      WHERE id = $1 AND sync_version ${op} $2`,
    [workspaceId, bound]
  );
  for (const row of workspaceRows.rows) {
    const deletedAt = toOptionalNumber(row.deleted_at);
    push(row, () =>
      deletedAt !== undefined
        ? {
            operation: "delete",
            workspaceId,
            cursor: String(row.sync_version),
            deletedAt,
            entityType: "workspace",
            entityId: String(row.id),
          }
        : {
            operation: "upsert",
            workspaceId,
            cursor: String(row.sync_version),
            entityType: "workspace",
            entityId: String(row.id),
            entity: rowToWorkspace(row),
          }
    );
  }

  const simple = [
    {
      table: "tabdump_sections",
      columns: "id, parent_id, name, source, created_at, updated_at, deleted_at, sync_version",
      entityType: "section" as const,
      map: rowToSection,
    },
    {
      table: "tabdump_groups",
      columns: "id, name, created_at, updated_at, deleted_at, sync_version",
      entityType: "group" as const,
      map: rowToGroup,
    },
    {
      table: "tabdump_tabs",
      columns: TAB_COLUMNS,
      entityType: "tab" as const,
      map: rowToTab,
    },
  ];

  for (const spec of simple) {
    const result = await client.query<Row>(
      `SELECT ${spec.columns} FROM ${spec.table}
        WHERE workspace_id = $1 AND sync_version ${op} $2
        ORDER BY sync_version${limitSql}`,
      [workspaceId, bound, ...limitParams]
    );
    for (const row of result.rows) {
      const deletedAt = toOptionalNumber(row.deleted_at);
      push(row, () =>
        deletedAt !== undefined
          ? {
              operation: "delete",
              workspaceId,
              cursor: String(row.sync_version),
              deletedAt,
              entityType: spec.entityType,
              entityId: String(row.id),
            }
          : {
              operation: "upsert",
              workspaceId,
              cursor: String(row.sync_version),
              entityType: spec.entityType,
              entityId: String(row.id),
              // The map functions are per-table and the entityType is fixed
              // alongside them, so this union narrowing is safe by
              // construction.
              entity: spec.map(row),
            } as SyncChange
      );
    }
  }

  // Collections carry their membership, so each one needs its ordered tab
  // list read alongside it. Membership is not separately versioned — see
  // schema.sql — so a membership change reaches a client through its
  // collection's version.
  const collectionRows = await client.query<Row>(
    `SELECT id, name, created_at, updated_at, deleted_at, sync_version
       FROM tabdump_collections
      WHERE workspace_id = $1 AND sync_version ${op} $2
      ORDER BY sync_version${limitSql}`,
    [workspaceId, bound, ...limitParams]
  );
  for (const row of collectionRows.rows) {
    const deletedAt = toOptionalNumber(row.deleted_at);
    if (deletedAt !== undefined) {
      push(row, () => ({
        operation: "delete",
        workspaceId,
        cursor: String(row.sync_version),
        deletedAt,
        entityType: "collection",
        entityId: String(row.id),
      }));
      continue;
    }
    const members = await client.query<Row>(
      `SELECT tab_id FROM tabdump_collection_tabs WHERE collection_id = $1 ORDER BY position`,
      [row.id]
    );
    const entity: CollectionSyncPayload = {
      id: String(row.id),
      name: String(row.name),
      tabIds: members.rows.map((m) => String(m.tab_id)),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
    push(row, () => ({
      operation: "upsert",
      workspaceId,
      cursor: String(row.sync_version),
      entityType: "collection",
      entityId: entity.id,
      entity,
    }));
  }

  const dependencyRows = await client.query<Row>(
    `SELECT parent_tab_id, child_tab_id, type, created_at, updated_at, deleted_at, sync_version
       FROM tabdump_dependencies
      WHERE workspace_id = $1 AND sync_version ${op} $2
      ORDER BY sync_version${limitSql}`,
    [workspaceId, bound, ...limitParams]
  );
  for (const row of dependencyRows.rows) {
    const deletedAt = toOptionalNumber(row.deleted_at);
    push(row, () =>
      deletedAt !== undefined
        ? {
            operation: "delete",
            workspaceId,
            cursor: String(row.sync_version),
            deletedAt,
            entityType: "dependency",
            parentTabId: String(row.parent_tab_id),
            childTabId: String(row.child_tab_id),
          }
        : {
            operation: "upsert",
            workspaceId,
            cursor: String(row.sync_version),
            entityType: "dependency",
            parentTabId: String(row.parent_tab_id),
            childTabId: String(row.child_tab_id),
            entity: rowToDependency(row),
          }
    );
  }

  collected.sort((a, b) => (a.version === b.version ? 0 : a.version < b.version ? -1 : 1));
  return collected;
}

/**
 * Every change in one workspace above `cursor`, ordered, cut at a version
 * boundary.
 *
 * `limit` bounds the rows fetched, not the rows returned: once the rows are
 * in hand the page is truncated to the last COMPLETE version, so a caller
 * never sees part of one transaction. The `+1` overfetch is what makes
 * `hasMore` truthful without a second count query.
 *
 * ## Why a version can need a second read
 *
 * The page limit and the per-push limit are independent: one push may write
 * up to SYNC_LIMITS.entitiesPerPush rows under a single version, which is
 * far more than a page. When such a version is the FIRST thing a page meets,
 * the overfetch cannot have collected all of it — the per-table reads
 * stopped at `limit + 1` rows.
 *
 * Returning what was fetched would be silent data loss rather than slow
 * paging: every row of that version shares its number, so the page's
 * `nextCursor` lands ON the version, and the client's next request asks only
 * for changes ABOVE it. The rows that were never fetched become permanently
 * unreachable. So that version is re-read in full, without a limit, and
 * delivered whole — atomicity wins over the page size, which is advisory.
 */
export async function readChangesSince(
  client: PoolClient,
  workspaceId: string,
  cursor: SyncCursor,
  limit: number
): Promise<{ changes: SyncChange[]; nextCursor: SyncCursor; hasMore: boolean }> {
  const collected = await collectChanges(client, workspaceId, { kind: "since", cursor, limit });

  if (collected.length === 0) {
    return { changes: [], nextCursor: cursor, hasMore: false };
  }

  // Cut at a version boundary. Taking the first `limit` rows outright could
  // split one transaction's writes across two pages, which would let a
  // client observe half of a bulk operation — exactly what the shared
  // version exists to prevent.
  let cut = collected.length;
  let hasMore = false;
  if (collected.length > limit) {
    const boundary = collected[limit].version;
    cut = collected.findIndex((entry) => entry.version === boundary);
    hasMore = true;
    if (cut === 0) {
      // The first version alone fills the page. It may also have been
      // truncated by the per-table limit, so read it completely.
      const whole = await collectChanges(client, workspaceId, { kind: "version", version: boundary });
      return {
        changes: whole.map((entry) => entry.change),
        nextCursor: boundary.toString(),
        // There is more only if something sits above this version. The
        // overfetch cannot answer that once it was saturated by this one, so
        // ask directly rather than guessing.
        hasMore: await hasChangesAbove(client, workspaceId, boundary),
      };
    }
  }

  const page = collected.slice(0, cut);
  const nextCursor = page.length > 0 ? page[page.length - 1].version.toString() : cursor;
  return { changes: page.map((entry) => entry.change), nextCursor, hasMore };
}

/** Whether any row in this workspace carries a version above `version`. */
async function hasChangesAbove(client: PoolClient, workspaceId: string, version: bigint): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM tabdump_workspaces  WHERE id = $1           AND sync_version > $2
       UNION ALL
       SELECT 1 FROM tabdump_sections    WHERE workspace_id = $1 AND sync_version > $2
       UNION ALL
       SELECT 1 FROM tabdump_groups      WHERE workspace_id = $1 AND sync_version > $2
       UNION ALL
       SELECT 1 FROM tabdump_tabs        WHERE workspace_id = $1 AND sync_version > $2
       UNION ALL
       SELECT 1 FROM tabdump_collections WHERE workspace_id = $1 AND sync_version > $2
       UNION ALL
       SELECT 1 FROM tabdump_dependencies WHERE workspace_id = $1 AND sync_version > $2
     ) AS present`,
    [workspaceId, version.toString()]
  );
  return rows[0]?.present === true;
}

/**
 * The server's current version for each entity a push is about to write.
 *
 * This is what makes per-entity conflict detection possible: comparing each
 * of these against the client's `baseCursor` answers "did this specific
 * object change since the client last read?" — which is a far narrower and
 * more useful question than "did anything in the workspace change?".
 */
export type EntityVersions = {
  tabs: Map<string, { version: bigint; sectionLocked: boolean; sectionId: string | null }>;
  sections: Map<string, bigint>;
  groups: Map<string, bigint>;
  collections: Map<string, bigint>;
  dependencies: Map<string, bigint>;
  workspace: bigint | null;
};

/** Key for a dependency, whose identity is its pair rather than an id. */
export function dependencyKey(parentTabId: string, childTabId: string): string {
  return `${parentTabId}::${childTabId}`;
}

export async function readEntityVersions(
  client: PoolClient,
  workspaceId: string
): Promise<EntityVersions> {
  // Sequential, NOT Promise.all.
  //
  // These six run on one PoolClient inside the push transaction, and a
  // single connection cannot execute queries in parallel — `pg` quietly
  // serializes overlapping calls today, warns that it is deprecated, and
  // removes the behaviour in pg@9. Issuing them in order costs nothing here
  // (they were being serialized regardless) and keeps every statement
  // unambiguously inside the transaction that holds the workspace's lock.
  const workspace = await client.query<Row>(
    `SELECT sync_version FROM tabdump_workspaces WHERE id = $1`,
    [workspaceId]
  );
  const tabs = await client.query<Row>(
    `SELECT id, sync_version, section_locked, section_id FROM tabdump_tabs WHERE workspace_id = $1`,
    [workspaceId]
  );
  const sections = await client.query<Row>(
    `SELECT id, sync_version FROM tabdump_sections WHERE workspace_id = $1`,
    [workspaceId]
  );
  const groups = await client.query<Row>(
    `SELECT id, sync_version FROM tabdump_groups WHERE workspace_id = $1`,
    [workspaceId]
  );
  const collections = await client.query<Row>(
    `SELECT id, sync_version FROM tabdump_collections WHERE workspace_id = $1`,
    [workspaceId]
  );
  const dependencies = await client.query<Row>(
    `SELECT parent_tab_id, child_tab_id, sync_version FROM tabdump_dependencies WHERE workspace_id = $1`,
    [workspaceId]
  );

  return {
    workspace: workspace.rows[0] ? BigInt(String(workspace.rows[0].sync_version)) : null,
    tabs: new Map(
      tabs.rows.map((row) => [
        String(row.id),
        {
          version: BigInt(String(row.sync_version)),
          sectionLocked: row.section_locked === true,
          sectionId: row.section_id === null || row.section_id === undefined ? null : String(row.section_id),
        },
      ])
    ),
    sections: new Map(sections.rows.map((row) => [String(row.id), BigInt(String(row.sync_version))])),
    groups: new Map(groups.rows.map((row) => [String(row.id), BigInt(String(row.sync_version))])),
    collections: new Map(collections.rows.map((row) => [String(row.id), BigInt(String(row.sync_version))])),
    dependencies: new Map(
      dependencies.rows.map((row) => [
        dependencyKey(String(row.parent_tab_id), String(row.child_tab_id)),
        BigInt(String(row.sync_version)),
      ])
    ),
  };
}
