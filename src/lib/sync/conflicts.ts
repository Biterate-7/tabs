/**
 * Conflicts, and the two resolutions a user can choose between.
 *
 * Phase 4 detected conflicts on the server and reported them. This makes
 * them durable and actionable on the client, and — the part that matters —
 * keeps BOTH versions. A conflict record that only remembered the remote
 * value would already have thrown the user's work away; one that only
 * remembered the local value would make "keep theirs" impossible.
 *
 * Everything here is pure. Resolution produces new state and new dirty refs;
 * it never writes, never fetches and never reads the clock.
 *
 *
 * ## What is deliberately absent
 *
 * No field-level automatic merge. Two devices that both changed a tab since
 * their shared base have genuinely conflicting versions, and without
 * per-field base information there is no honest way to tell "they changed
 * the title, I changed the favourite" from "we both changed the title".
 * Guessing would silently discard an edit, so this returns a conflict and
 * lets a human decide. Conservative on purpose.
 */

import { toTabPayload } from "./serialize";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Group, Workspace } from "@/lib/workspace/types";
import type { DirtyRef } from "./diff";
import type {
  SectionSyncPayload,
  GroupSyncPayload,
  SyncCursor,
  SyncEntityType,
  TabSyncPayload,
  WorkspaceSyncPayload,
} from "./types";

/**
 * Why the two sides disagree.
 *
 *  - `changed-since-base`  both edited the same entity since their shared
 *                          base cursor.
 *  - `locked-section`      an automatic placement tried to move a tab a
 *                          human had locked. Distinct because the resolution
 *                          advice is different: the manual side is usually
 *                          right, and the UI can say so.
 *  - `local-edit-remote-delete` / `local-delete-remote-edit`
 *                          one side removed what the other was editing.
 *                          Never resolved by a timestamp.
 */
export type SyncConflictReason =
  | "changed-since-base"
  | "locked-section"
  | "local-edit-remote-delete"
  | "local-delete-remote-edit";

/** The syncable payload for whichever entity type this conflict is about. */
export type ConflictPayload =
  | { entityType: "workspace"; entity: WorkspaceSyncPayload }
  | { entityType: "tab"; entity: TabSyncPayload }
  | { entityType: "section"; entity: SectionSyncPayload }
  | { entityType: "group"; entity: GroupSyncPayload };

/**
 * A durable conflict.
 *
 * `local` and `remote` are both present unless one side is a deletion, in
 * which case that side is null and the reason says so. Keeping the payloads
 * — rather than ids to look up later — is what lets the record survive a
 * reload and still show the user what they are choosing between, even after
 * local state has moved on.
 */
export type LocalSyncConflict = {
  id: string;
  workspaceId: string;
  entityType: Exclude<SyncEntityType, "collection" | "dependency">;
  entityId: string;
  reason: SyncConflictReason;
  /** The version this device holds. Null when this device deleted it. */
  local: ConflictPayload | null;
  /** The version the server holds. Null when the server deleted it. */
  remote: ConflictPayload | null;
  /** The cursor the local edit was based on, for explaining and for retry. */
  baseCursor: SyncCursor;
  /** The server's version of the entity at detection time. */
  serverCursor: SyncCursor;
  createdAt: number;
};

export function conflictId(workspaceId: string, entityType: string, entityId: string): string {
  // Deterministic rather than random: re-detecting the same conflict must
  // update one record, not accumulate a new one on every sync attempt.
  return `${workspaceId}:${entityType}:${entityId}`;
}

function payloadFor(
  entityType: LocalSyncConflict["entityType"],
  workspace: Workspace,
  entityId: string
): ConflictPayload | null {
  switch (entityType) {
    case "workspace":
      return workspace.id === entityId
        ? {
            entityType: "workspace",
            entity: {
              id: workspace.id,
              name: workspace.name,
              ...(workspace.logo !== undefined ? { logo: workspace.logo } : {}),
              createdAt: workspace.createdAt,
              updatedAt: workspace.updatedAt,
            },
          }
        : null;
    case "tab": {
      const tab = workspace.tabs.find((t) => t.id === entityId);
      return tab ? { entityType: "tab", entity: toTabPayload(tab) } : null;
    }
    case "section": {
      const section = (workspace.sections ?? []).find((s) => s.id === entityId);
      return section ? { entityType: "section", entity: { ...section } } : null;
    }
    case "group": {
      const group = (workspace.groups ?? []).find((g) => g.id === entityId);
      return group ? { entityType: "group", entity: { ...group } } : null;
    }
  }
}

/**
 * Builds a durable record from a server-reported conflict plus the local
 * state at that moment.
 *
 * `remote` is whatever the caller could read back from the server; it may be
 * null when the server's answer was a tombstone or when the entity was not
 * in the page that was pulled.
 */
export function buildConflict(input: {
  workspaceId: string;
  entityType: LocalSyncConflict["entityType"];
  entityId: string;
  reason: SyncConflictReason;
  workspace: Workspace;
  remote: ConflictPayload | null;
  baseCursor: SyncCursor;
  serverCursor: SyncCursor;
  now: number;
}): LocalSyncConflict {
  return {
    id: conflictId(input.workspaceId, input.entityType, input.entityId),
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    entityId: input.entityId,
    reason: input.reason,
    local: payloadFor(input.entityType, input.workspace, input.entityId),
    remote: input.remote,
    baseCursor: input.baseCursor,
    serverCursor: input.serverCursor,
    createdAt: input.now,
  };
}

export type Resolution = {
  /** The workspace after the choice is applied. */
  workspace: Workspace;
  /**
   * What must now be pushed.
   *
   * Keep-local produces a dirty ref: the local version has to be re-sent
   * against the server's NEW cursor, which is what turns a resolution into a
   * legitimate mutation rather than a record quietly deleted.
   *
   * Keep-remote produces none: the value came from the server, so re-pushing
   * it would be the sync loop this design exists to avoid.
   */
  dirty: DirtyRef[];
};

/**
 * Keep this device's version.
 *
 * The local state is already what the user wants, so the workspace is
 * returned unchanged and the entity is marked dirty. The engine then pushes
 * it against the server's current cursor — which may itself conflict again
 * if a third device moved in the meantime, and that is correct.
 */
export function resolveKeepLocal(conflict: LocalSyncConflict, workspace: Workspace): Resolution {
  if (conflict.local === null) {
    // This device deleted it and is standing by that.
    return {
      workspace,
      dirty: [{ ref: { entityType: conflict.entityType, entityId: conflict.entityId }, deleted: true }],
    };
  }
  return {
    workspace,
    dirty: [{ ref: { entityType: conflict.entityType, entityId: conflict.entityId }, deleted: false }],
  };
}

/**
 * Take the server's version.
 *
 * Applies the remote payload to local state and marks NOTHING dirty. The
 * value originated on the server, so pushing it back would re-upload a
 * change the server already has — the recursive loop §22 forbids.
 *
 * A null remote means the server deleted it, so the local copy goes too.
 */
export function resolveKeepRemote(conflict: LocalSyncConflict, workspace: Workspace): Resolution {
  if (conflict.remote === null) {
    return { workspace: removeEntity(workspace, conflict.entityType, conflict.entityId), dirty: [] };
  }
  return { workspace: applyPayload(workspace, conflict.remote), dirty: [] };
}

function removeEntity(
  workspace: Workspace,
  entityType: LocalSyncConflict["entityType"],
  entityId: string
): Workspace {
  switch (entityType) {
    case "tab":
      return { ...workspace, tabs: workspace.tabs.filter((t) => t.id !== entityId) };
    case "section":
      return workspace.sections
        ? { ...workspace, sections: workspace.sections.filter((s) => s.id !== entityId) }
        : workspace;
    case "group":
      return workspace.groups
        ? { ...workspace, groups: workspace.groups.filter((g) => g.id !== entityId) }
        : workspace;
    case "workspace":
      // Deleting the whole workspace is never done as a side effect of
      // resolving one conflict; the caller surfaces it instead.
      return workspace;
  }
}

function applyPayload(workspace: Workspace, payload: ConflictPayload): Workspace {
  switch (payload.entityType) {
    case "workspace":
      return {
        ...workspace,
        name: payload.entity.name,
        createdAt: payload.entity.createdAt,
        updatedAt: payload.entity.updatedAt,
        ...(payload.entity.logo !== undefined ? { logo: payload.entity.logo } : {}),
      };
    case "tab": {
      const index = workspace.tabs.findIndex((t) => t.id === payload.entity.id);
      if (index === -1) return workspace;
      const existing = workspace.tabs[index];
      const tabs = [...workspace.tabs];
      // Derived fields (normalizedUrl, domain, isDuplicate) are kept from the
      // local copy rather than invented: the URL is unchanged by definition
      // of this being the same entity, and isDuplicate is recomputed across
      // the whole list anyway.
      tabs[index] = { ...existing, ...(payload.entity as Partial<Tab>) } as Tab;
      return { ...workspace, tabs };
    }
    case "section": {
      const sections = workspace.sections ?? [];
      const index = sections.findIndex((s) => s.id === payload.entity.id);
      if (index === -1) return workspace;
      const next = [...sections];
      next[index] = { ...next[index], ...(payload.entity as Partial<Section>) };
      return { ...workspace, sections: next };
    }
    case "group": {
      const groups = workspace.groups ?? [];
      const index = groups.findIndex((g) => g.id === payload.entity.id);
      if (index === -1) return workspace;
      const next = [...groups];
      next[index] = { ...next[index], ...(payload.entity as Partial<Group>) };
      return { ...workspace, groups: next };
    }
  }
}

/**
 * Whether a conflict's manual-organization intent should be highlighted.
 *
 * `sectionLocked` records that a human placed this tab. When that is the
 * side at risk, the UI should say so rather than presenting two equivalent
 * options — the default advice is to keep the manual placement.
 */
export function favoursLocalManualIntent(conflict: LocalSyncConflict): boolean {
  if (conflict.reason === "locked-section") return true;
  return conflict.local?.entityType === "tab" && conflict.local.entity.sectionLocked === true;
}
