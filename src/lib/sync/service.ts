import "server-only";
import type { Pool } from "pg";
import { SyncRepository } from "./repository";
import type { WorkspaceMutation } from "./repository";
import { dependencyKey, readChangesSince } from "./changes";
import type { EntityVersions } from "./changes";
import { SYNC_LIMITS } from "./validation";
import type {
  SyncChange,
  SyncChangesPage,
  SyncCursor,
  SyncEntityRef,
  SyncEntityType,
  SyncUpsert,
  WorkspaceSyncPayload,
} from "./types";

/**
 * The synchronization operations themselves: initial migration, push, pull.
 *
 * Sits between the route handlers (which parse, authenticate and serialize)
 * and the repository (which owns SQL and transactions). A route calls one
 * method here and turns the result into a response; it never writes SQL and
 * never decides a conflict rule.
 *
 *
 * ## What this phase does and does not do
 *
 * Conflict DETECTION is implemented. Conflict RESOLUTION is not, and that is
 * deliberate — see the note above `detectConflicts`. A conflict is reported
 * with enough information for a future UI to explain it, and nothing is
 * overwritten in the meantime. "Last writer wins" is never applied.
 */

/** Bounds on one request. A push is a user action, not a bulk import channel. */
export const SYNC_REQUEST_LIMITS = {
  /** Entities in one initial migration — a very large workspace, still finite. */
  initialEntities: SYNC_LIMITS.entitiesPerPush,
  /** Upserts + deletes in one push. */
  pushChanges: 2000,
  /** Changes returned by one pull. */
  pullPageSize: 500,
} as const;

export type EntityConflict = {
  entityType: SyncEntityType;
  /** Absent for a dependency, whose identity is its pair. */
  entityId?: string;
  parentTabId?: string;
  childTabId?: string;
  /** The cursor the client said it was writing against. */
  baseCursor: SyncCursor;
  /** The version the server currently holds for this entity. */
  serverCursor: SyncCursor;
  reason: "changed-since-base" | "locked-section";
};

export type PushOutcome =
  | { ok: true; cursor: SyncCursor; accepted: SyncChange[] }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "stale-base"; serverCursor: SyncCursor }
  | { ok: false; reason: "conflict"; serverCursor: SyncCursor; conflicts: EntityConflict[] };

export type InitialOutcome =
  | { ok: true; workspace: WorkspaceSyncPayload; cursor: SyncCursor; created: boolean }
  /**
   * The caller owns this workspace and the server already has it.
   *
   * Deliberately NOT `conflict`. Nothing is contended and no entity
   * disagrees — the client simply asked to create something that exists,
   * which is the ordinary situation for a second device. The answer is
   * adoption, not resolution, so it must not be reported through the
   * machinery a real disagreement uses.
   */
  | { ok: false; reason: "already-exists"; serverCursor: SyncCursor }
  | { ok: false; reason: "conflict"; serverCursor: SyncCursor }
  | { ok: false; reason: "too-large"; detail: string };

export type InitialPayload = {
  workspace: WorkspaceSyncPayload;
  upserts: SyncUpsert[];
};

/**
 * Whether each incoming entity is still based on what the server holds.
 *
 * The rule, per entity: if the server's version for that object is greater
 * than the cursor the client based its edit on, the object changed
 * underneath the client and the write is refused. If it is less than or
 * equal, the client has seen the current state and the write is safe.
 *
 * This is narrower and far more useful than comparing the workspace cursor
 * alone: two devices editing different tabs in the same workspace do not
 * conflict, and should not be told they do.
 *
 * ## The locked-section rule
 *
 * `sectionLocked` means a human placed this tab, and the local AI organizer
 * already refuses to move such a tab. That guarantee has to hold across
 * devices too, so an incoming write that would move a locked tab into a
 * different section WITHOUT itself being a manual placement is refused even
 * when versions agree. A genuine manual move from another device arrives
 * with `sectionLocked: true` and is accepted — the rule targets automatic
 * reorganization overriding a human decision, not the human changing
 * their mind.
 *
 * Deliberately conservative: reporting a conflict costs the user a prompt,
 * while silently discarding their manual organization costs them work they
 * cannot get back.
 */
function detectConflicts(
  upserts: SyncUpsert[],
  deletes: SyncEntityRef[],
  versions: EntityVersions,
  baseCursor: SyncCursor
): EntityConflict[] {
  const base = BigInt(baseCursor);
  const conflicts: EntityConflict[] = [];

  const changedSince = (version: bigint | undefined): boolean => version !== undefined && version > base;

  for (const upsert of upserts) {
    if (upsert.entityType === "dependency") {
      const key = dependencyKey(upsert.entity.parentTabId, upsert.entity.childTabId);
      const version = versions.dependencies.get(key);
      if (changedSince(version)) {
        conflicts.push({
          entityType: "dependency",
          parentTabId: upsert.entity.parentTabId,
          childTabId: upsert.entity.childTabId,
          baseCursor,
          serverCursor: version!.toString(),
          reason: "changed-since-base",
        });
      }
      continue;
    }

    if (upsert.entityType === "workspace") {
      if (changedSince(versions.workspace ?? undefined)) {
        conflicts.push({
          entityType: "workspace",
          entityId: upsert.entity.id,
          baseCursor,
          serverCursor: versions.workspace!.toString(),
          reason: "changed-since-base",
        });
      }
      continue;
    }

    const id = upsert.entity.id;
    const map =
      upsert.entityType === "tab"
        ? undefined
        : upsert.entityType === "section"
          ? versions.sections
          : upsert.entityType === "group"
            ? versions.groups
            : versions.collections;

    if (upsert.entityType === "tab") {
      const server = versions.tabs.get(id);
      if (changedSince(server?.version)) {
        conflicts.push({
          entityType: "tab",
          entityId: id,
          baseCursor,
          serverCursor: server!.version.toString(),
          reason: "changed-since-base",
        });
        continue;
      }
      if (server?.sectionLocked) {
        const incomingSection = upsert.entity.sectionId ?? null;
        const movesIt = incomingSection !== server.sectionId;
        const isManual = upsert.entity.sectionLocked === true;
        if (movesIt && !isManual) {
          conflicts.push({
            entityType: "tab",
            entityId: id,
            baseCursor,
            serverCursor: server.version.toString(),
            reason: "locked-section",
          });
        }
      }
      continue;
    }

    const version = map!.get(id);
    if (changedSince(version)) {
      conflicts.push({
        entityType: upsert.entityType,
        entityId: id,
        baseCursor,
        serverCursor: version!.toString(),
        reason: "changed-since-base",
      });
    }
  }

  // A delete of something that changed since the client's base is the same
  // hazard as an update: the client is discarding an edit it never saw.
  for (const ref of deletes) {
    if (ref.entityType === "dependency") {
      const version = versions.dependencies.get(dependencyKey(ref.parentTabId, ref.childTabId));
      if (changedSince(version)) {
        conflicts.push({
          entityType: "dependency",
          parentTabId: ref.parentTabId,
          childTabId: ref.childTabId,
          baseCursor,
          serverCursor: version!.toString(),
          reason: "changed-since-base",
        });
      }
      continue;
    }
    const version =
      ref.entityType === "tab"
        ? versions.tabs.get(ref.entityId)?.version
        : ref.entityType === "section"
          ? versions.sections.get(ref.entityId)
          : ref.entityType === "group"
            ? versions.groups.get(ref.entityId)
            : ref.entityType === "collection"
              ? versions.collections.get(ref.entityId)
              : (versions.workspace ?? undefined);
    if (changedSince(version)) {
      conflicts.push({
        entityType: ref.entityType,
        entityId: ref.entityId,
        baseCursor,
        serverCursor: version!.toString(),
        reason: "changed-since-base",
      });
    }
  }

  return conflicts;
}

/**
 * Applies upserts in dependency order.
 *
 * Sections before groups before tabs before collections before dependencies,
 * because the schema's composite foreign keys mean a tab cannot reference a
 * section that is not there yet. The constraints on the optional
 * relationships are DEFERRABLE, so this ordering is belt-and-braces rather
 * than strictly required — but relying on deferral for something this easy
 * to get right would be a poor trade.
 */
async function applyUpserts(
  mutation: WorkspaceMutation,
  upserts: SyncUpsert[]
): Promise<void> {
  const order: SyncEntityType[] = ["workspace", "section", "group", "tab", "collection", "dependency"];
  for (const type of order) {
    for (const upsert of upserts) {
      if (upsert.entityType !== type) continue;
      switch (upsert.entityType) {
        case "workspace":
          await mutation.upsertWorkspace(upsert.entity);
          break;
        case "section":
          await mutation.upsertSection(upsert.entity);
          break;
        case "group":
          await mutation.upsertGroup(upsert.entity);
          break;
        case "tab":
          await mutation.upsertTab(upsert.entity);
          break;
        case "collection":
          await mutation.upsertCollection(upsert.entity);
          break;
        case "dependency":
          await mutation.upsertDependency(upsert.entity);
          break;
      }
    }
  }
}

async function applyDeletes(
  mutation: WorkspaceMutation,
  deletes: SyncEntityRef[],
  deletedAt: number
): Promise<void> {
  // Reverse of the upsert order: a dependency has to be tombstoned before
  // the tab it points at, or a hard-delete path would trip the foreign key.
  const order: SyncEntityType[] = ["dependency", "collection", "tab", "group", "section", "workspace"];
  for (const type of order) {
    for (const ref of deletes) {
      if (ref.entityType !== type) continue;
      switch (ref.entityType) {
        case "dependency":
          await mutation.deleteDependency(ref.parentTabId, ref.childTabId, deletedAt);
          break;
        case "collection":
          await mutation.deleteCollection(ref.entityId, deletedAt);
          break;
        case "tab":
          await mutation.deleteTab(ref.entityId, deletedAt);
          break;
        case "group":
          await mutation.deleteGroup(ref.entityId, deletedAt);
          break;
        case "section":
          await mutation.deleteSection(ref.entityId, deletedAt);
          break;
        case "workspace":
          // Workspace deletion is not part of this phase's push surface:
          // tombstoning a whole workspace needs a decision about its
          // children that belongs with the deletion UX, not here.
          break;
      }
    }
  }
}

export class SyncService {
  private readonly repository: SyncRepository;

  constructor(private readonly pool: Pool) {
    this.repository = new SyncRepository(pool);
  }

  /**
   * Uploads a workspace for the first time, or re-uploads it idempotently.
   *
   * Everything happens in one transaction, so a client never sees — and the
   * database never holds — half a workspace. A retry after a lost response
   * finds the workspace already present and takes the update path, which is
   * keyed on the client's own ids and therefore produces no duplicates.
   *
   * If the workspace already exists and has moved past the cursor the client
   * says it knows, this refuses rather than overwriting. There is no force
   * path.
   */
  async initial(
    payload: InitialPayload,
    userId: string,
    knownCursor: SyncCursor | null
  ): Promise<InitialOutcome> {
    if (payload.upserts.length > SYNC_REQUEST_LIMITS.initialEntities) {
      return {
        ok: false,
        reason: "too-large",
        detail: `A workspace may carry at most ${SYNC_REQUEST_LIMITS.initialEntities} entities.`,
      };
    }

    const existing = await this.repository.getCursor(payload.workspace.id, userId);

    if (existing === null) {
      // Either brand new, or owned by someone else. createWorkspace binds
      // user_id from the session; if the id belongs to another account the
      // insert violates the primary key and the error surfaces rather than
      // silently attaching to their row.
      await this.repository.createWorkspace(payload.workspace, userId);
      const result = await this.repository.mutateWorkspace(
        payload.workspace.id,
        userId,
        {},
        async (mutation) => {
          await mutation.upsertWorkspace(payload.workspace);
          await applyUpserts(mutation, payload.upserts);
        }
      );
      if (!result.ok) {
        // The workspace was created a moment ago and is owned by this user,
        // so this is not reachable through ordinary use.
        return { ok: false, reason: "conflict", serverCursor: "0" };
      }
      return { ok: true, workspace: payload.workspace, cursor: result.cursor, created: true };
    }

    // Already there. A retry says so by sending the cursor it last saw; a
    // client that has never synced sends null and is told the workspace
    // exists rather than having it overwritten.
    //
    // `already-exists` rather than `conflict`: this is the second-device
    // case, and the client's correct next move is to adopt what is here.
    if (knownCursor === null || knownCursor !== existing) {
      return { ok: false, reason: "already-exists", serverCursor: existing };
    }

    const result = await this.repository.mutateWorkspace(
      payload.workspace.id,
      userId,
      { expectedCursor: existing },
      async (mutation) => {
        await mutation.upsertWorkspace(payload.workspace);
        await applyUpserts(mutation, payload.upserts);
      }
    );
    if (!result.ok) {
      return { ok: false, reason: "conflict", serverCursor: result.cursor ?? existing };
    }
    return { ok: true, workspace: payload.workspace, cursor: result.cursor, created: false };
  }

  /**
   * Applies a batch of changes, all or nothing.
   *
   * Order of checks matters: ownership, then the workspace-level base
   * cursor, then per-entity conflicts, then the writes. Each refusal happens
   * before anything is written, and the whole thing runs inside the
   * transaction that holds the workspace's row lock — so no other push can
   * interleave between the conflict check and the write.
   */
  async push(
    workspaceId: string,
    userId: string,
    baseCursor: SyncCursor,
    upserts: SyncUpsert[],
    deletes: SyncEntityRef[],
    deletedAt: number
  ): Promise<PushOutcome> {
    let conflicts: EntityConflict[] = [];
    let staleServerCursor: SyncCursor | null = null;

    const result = await this.repository.mutateWorkspace(
      workspaceId,
      userId,
      { expectedCursor: baseCursor },
      async (mutation) => {
        const versions = await mutation.readEntityVersions();
        conflicts = detectConflicts(upserts, deletes, versions, baseCursor);
        if (conflicts.length > 0) {
          // Abandons the transaction without writing. Throwing is how a
          // caller inside mutateWorkspace signals "roll this back"; the
          // sentinel is caught immediately below.
          throw new ConflictSignal();
        }
        await applyUpserts(mutation, upserts);
        await applyDeletes(mutation, deletes, deletedAt);
      }
    ).catch((error: unknown) => {
      if (error instanceof ConflictSignal) return { ok: false as const, reason: "conflict" as const };
      throw error;
    });

    if (!result.ok) {
      if (result.reason === "not-found") return { ok: false, reason: "not-found" };
      if (conflicts.length > 0) {
        return { ok: false, reason: "conflict", serverCursor: baseCursor, conflicts };
      }
      staleServerCursor = ("cursor" in result && result.cursor) || null;
      return { ok: false, reason: "stale-base", serverCursor: staleServerCursor ?? baseCursor };
    }

    // What the server actually stored, echoed back so the client never has
    // to guess what was accepted.
    const accepted: SyncChange[] = [
      ...upserts.map(
        (upsert) =>
          ({
            operation: "upsert",
            workspaceId,
            cursor: result.cursor,
            entityType: upsert.entityType,
            ...(upsert.entityType === "dependency"
              ? { parentTabId: upsert.entity.parentTabId, childTabId: upsert.entity.childTabId }
              : { entityId: upsert.entity.id }),
            entity: upsert.entity,
          }) as SyncChange
      ),
      ...deletes.map(
        (ref) =>
          ({
            operation: "delete",
            workspaceId,
            cursor: result.cursor,
            deletedAt,
            ...ref,
          }) as SyncChange
      ),
    ];

    return { ok: true, cursor: result.cursor, accepted };
  }

  /**
   * Every workspace this user owns — metadata only.
   *
   * What a device with no local copy needs in order to know there is
   * anything to adopt. Deliberately no contents: discovery answers
   * "what exists", and hydration is a separate, paged read.
   */
  async listWorkspaces(userId: string): Promise<WorkspaceSyncPayload[]> {
    return this.repository.listWorkspaces(userId);
  }

  /** Changes since `cursor`, or null when this user does not own the workspace. */
  async pull(
    workspaceId: string,
    userId: string,
    cursor: SyncCursor,
    limit = SYNC_REQUEST_LIMITS.pullPageSize
  ): Promise<SyncChangesPage | null> {
    const owns = await this.repository.getCursor(workspaceId, userId);
    if (owns === null) return null;

    const client = await this.pool.connect();
    try {
      const page = await readChangesSince(client, workspaceId, cursor, limit);
      return { workspaceId, ...page };
    } finally {
      client.release();
    }
  }
}

class ConflictSignal extends Error {
  constructor() {
    super("sync: conflict");
    this.name = "ConflictSignal";
  }
}
