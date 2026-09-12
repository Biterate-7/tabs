/**
 * Folding pulled changes into a local workspace.
 *
 * A pure reducer over `(localState, changes) → nextState`, matching the rest
 * of the domain layer: no storage, no network, no clock. The caller commits
 * the result through the existing seam.
 *
 *
 * ## By identity, never wholesale
 *
 * Each change names one entity, and only that entity is touched. Replacing
 * the workspace with a server snapshot would silently discard any local
 * entity the server has not heard about — which, on a first pull, is all of
 * them.
 *
 *
 * ## Absence is not deletion
 *
 * Nothing is removed because the server failed to mention it. A local tab
 * disappears only when an explicit `delete` change names its id. That is why
 * tombstones exist, and it is the invariant that makes an empty server safe.
 *
 *
 * ## Local edits win a tie by being reported, not overwritten
 *
 * `dirtyEntityIds` names entities the caller knows have unsynced local
 * changes. A remote change to one of those is NOT applied: it is returned in
 * `conflicts` for the caller to surface. Applying it would destroy a local
 * edit the user has not had a chance to see, which is the one outcome this
 * phase is built to prevent.
 */

import { fromTabPayload } from "./serialize";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";
import type { Group, Workspace } from "@/lib/workspace/types";
import type { SyncChange } from "./types";

export type LocalSyncState = {
  workspace: Workspace;
  collections: Collection[];
  dependencies: TabDependency[];
};

export type ApplyConflict = {
  entityType: SyncChange["entityType"];
  entityId: string;
  reason: "local-unsynced-change";
};

export type ApplyResult = {
  state: LocalSyncState;
  /** Remote changes withheld because the same entity has a local unsynced edit. */
  conflicts: ApplyConflict[];
  /** Changes that were applied, for the caller's logging/UI. */
  applied: number;
  /** Remote tabs dropped because their URL is not http(s). Should be zero against our own server. */
  rejected: number;
};

function dependencyId(parentTabId: string, childTabId: string): string {
  return `dep-${parentTabId}::${childTabId}`;
}

export function applyChanges(
  state: LocalSyncState,
  changes: readonly SyncChange[],
  dirtyEntityIds: ReadonlySet<string> = new Set()
): ApplyResult {
  let workspace = state.workspace;
  let tabs = state.workspace.tabs;
  let sections = state.workspace.sections;
  let groups = state.workspace.groups;
  let collections = state.collections;
  let dependencies = state.dependencies;

  const conflicts: ApplyConflict[] = [];
  let applied = 0;
  let rejected = 0;

  /** Replaces by id, or appends when this entity is new to the device. */
  const upsertById = <T extends { id: string }>(list: T[] | undefined, entity: T): T[] => {
    const current = list ?? [];
    const index = current.findIndex((item) => item.id === entity.id);
    if (index === -1) return [...current, entity];
    const next = [...current];
    next[index] = entity;
    return next;
  };

  const removeById = <T extends { id: string }>(list: T[] | undefined, id: string): T[] | undefined => {
    if (!list) return list;
    const next = list.filter((item) => item.id !== id);
    return next.length === list.length ? list : next;
  };

  for (const change of changes) {
    const id =
      change.entityType === "dependency"
        ? dependencyId(change.parentTabId, change.childTabId)
        : change.entityId;

    if (dirtyEntityIds.has(id)) {
      conflicts.push({ entityType: change.entityType, entityId: id, reason: "local-unsynced-change" });
      continue;
    }

    if (change.operation === "delete") {
      switch (change.entityType) {
        case "workspace":
          // A tombstoned workspace is not deleted here. Removing the user's
          // whole workspace as a side effect of a background pull is exactly
          // the destructive action this phase forbids; the caller surfaces it.
          conflicts.push({ entityType: "workspace", entityId: id, reason: "local-unsynced-change" });
          break;
        case "tab":
          tabs = tabs.filter((tab) => tab.id !== id);
          applied++;
          break;
        case "section":
          sections = removeById(sections, id);
          applied++;
          break;
        case "group":
          groups = removeById(groups, id);
          applied++;
          break;
        case "collection":
          collections = collections.filter((collection) => collection.id !== id);
          applied++;
          break;
        case "dependency":
          dependencies = dependencies.filter((dependency) => dependency.id !== id);
          applied++;
          break;
      }
      continue;
    }

    switch (change.entityType) {
      case "workspace":
        workspace = {
          ...workspace,
          name: change.entity.name,
          createdAt: change.entity.createdAt,
          updatedAt: change.entity.updatedAt,
          ...(change.entity.logo !== undefined ? { logo: change.entity.logo } : {}),
        };
        applied++;
        break;
      case "tab": {
        const tab = fromTabPayload(change.entity);
        if (!tab) {
          rejected++;
          break;
        }
        tabs = upsertById<Tab>(tabs, tab);
        applied++;
        break;
      }
      case "section":
        sections = upsertById<Section>(sections, change.entity);
        applied++;
        break;
      case "group":
        groups = upsertById<Group>(groups, change.entity);
        applied++;
        break;
      case "collection":
        collections = upsertById<Collection>(collections, {
          ...change.entity,
          workspaceId: workspace.id,
        });
        applied++;
        break;
      case "dependency": {
        const entity: TabDependency = {
          id: dependencyId(change.entity.parentTabId, change.entity.childTabId),
          parentTabId: change.entity.parentTabId,
          childTabId: change.entity.childTabId,
          createdAt: change.entity.createdAt,
          ...(change.entity.type !== undefined ? { type: change.entity.type } : {}),
          ...(change.entity.updatedAt !== undefined ? { updatedAt: change.entity.updatedAt } : {}),
        };
        dependencies = upsertById<TabDependency>(dependencies, entity);
        applied++;
        break;
      }
    }
  }

  return {
    state: {
      workspace: {
        ...workspace,
        tabs,
        ...(sections ? { sections } : {}),
        ...(groups ? { groups } : {}),
      },
      collections,
      dependencies,
    },
    conflicts,
    applied,
    rejected,
  };
}
