/**
 * What changed between two committed workspace states.
 *
 * This is the whole "pending mutation journal", and it is deliberately not
 * an event log. A push sends the CURRENT state of an entity rather than a
 * delta, so the only thing worth remembering between a local edit and a
 * successful push is *which entities* changed — not how, and not in what
 * order. Ten edits to one tab collapse to one dirty id and therefore one
 * upsert, which is both the coalescing the scheduler wants and the
 * idempotency a retry needs, for free.
 *
 * Everything here is pure: no storage, no clock, no network.
 *
 *
 * ## What counts as dirty
 *
 * Only material changes to user-owned, server-syncable state. The fields
 * Phase 3 decided not to sync (normalizedUrl, domain, isDuplicate, favicon)
 * are excluded, so recomputing them never schedules a push. Identical
 * re-commits produce nothing — the same discipline Phase 2 established for
 * `updatedAt`, for the same reason: a render, a hydration or a derived
 * recompute must not look like a user edit.
 */

import {
  toCollectionPayload,
  toDependencyPayload,
  toGroupPayload,
  toSectionPayload,
  toTabPayload,
  toWorkspacePayload,
} from "./serialize";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";
import type { Group, Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { SyncEntityRef, SyncUpsert } from "./types";

/** One entity that differs, and whether it is gone. */
export type DirtyRef = { ref: SyncEntityRef; deleted: boolean };

/** A stable string key for a ref, usable in a Set/Record. Dependencies key on their pair, matching how the client mints their id. */
export function refKey(ref: SyncEntityRef): string {
  return ref.entityType === "dependency"
    ? `dependency:${ref.parentTabId}::${ref.childTabId}`
    : `${ref.entityType}:${ref.entityId}`;
}

/**
 * Compares the syncable projection of two entities rather than the objects
 * themselves.
 *
 * Going through the serializer is what keeps derived fields out: two tabs
 * differing only in `isDuplicate` or `normalizedUrl` produce identical
 * payloads and so are not dirty. Comparing the domain objects directly
 * would mark a tab dirty every time markDuplicates ran.
 */
function payloadChanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function indexById<T extends { id: string }>(list: readonly T[] | undefined): Map<string, T> {
  return new Map((list ?? []).map((item) => [item.id, item]));
}

/**
 * Dirty entities between two versions of one workspace.
 *
 * A missing workspace on either side is handled by the caller: this compares
 * two that exist.
 */
export function diffWorkspace(before: Workspace | undefined, after: Workspace | undefined): DirtyRef[] {
  const dirty: DirtyRef[] = [];

  if (!after) {
    // The workspace is gone locally. Deleting a whole workspace is not part
    // of this phase's push surface (see applyDeletes in service.ts), so the
    // entities are not individually tombstoned here either — reporting the
    // workspace itself is enough for a caller to decide.
    if (before) dirty.push({ ref: { entityType: "workspace", entityId: before.id }, deleted: true });
    return dirty;
  }

  if (!before) {
    // Brand new workspace: everything in it is dirty.
    dirty.push({ ref: { entityType: "workspace", entityId: after.id }, deleted: false });
    for (const section of after.sections ?? []) {
      dirty.push({ ref: { entityType: "section", entityId: section.id }, deleted: false });
    }
    for (const group of after.groups ?? []) {
      dirty.push({ ref: { entityType: "group", entityId: group.id }, deleted: false });
    }
    for (const tab of after.tabs) {
      dirty.push({ ref: { entityType: "tab", entityId: tab.id }, deleted: false });
    }
    return dirty;
  }

  if (payloadChanged(toWorkspacePayload(before), toWorkspacePayload(after))) {
    dirty.push({ ref: { entityType: "workspace", entityId: after.id }, deleted: false });
  }

  const compare = <T extends { id: string }>(
    entityType: Exclude<SyncEntityRef["entityType"], "dependency">,
    beforeList: readonly T[] | undefined,
    afterList: readonly T[] | undefined,
    toPayload: (item: T) => unknown
  ) => {
    const beforeIndex = indexById(beforeList);
    const afterIndex = indexById(afterList);

    for (const [id, item] of afterIndex) {
      const previous = beforeIndex.get(id);
      if (!previous || payloadChanged(toPayload(previous), toPayload(item))) {
        dirty.push({ ref: { entityType, entityId: id }, deleted: false });
      }
    }
    for (const id of beforeIndex.keys()) {
      if (!afterIndex.has(id)) dirty.push({ ref: { entityType, entityId: id }, deleted: true });
    }
  };

  compare<Section>("section", before.sections, after.sections, toSectionPayload);
  compare<Group>("group", before.groups, after.groups, toGroupPayload);
  compare<Tab>("tab", before.tabs, after.tabs, toTabPayload);

  return dirty;
}

/**
 * Dirty entities per workspace between two committed stores.
 *
 * Keyed by workspace id so the scheduler can mark exactly the workspaces
 * that changed — an edit in one workspace must not schedule a push for the
 * other nineteen.
 *
 * A workspace present in both and referentially identical is skipped before
 * any comparison: the reducers return the same object when nothing changed,
 * so the common case costs one pointer comparison rather than a diff.
 */
export function diffStores(
  before: WorkspaceStore | null,
  after: WorkspaceStore | null
): Map<string, DirtyRef[]> {
  const result = new Map<string, DirtyRef[]>();
  if (!after) return result;

  const beforeIndex = new Map((before?.workspaces ?? []).map((w) => [w.id, w]));

  for (const workspace of after.workspaces) {
    const previous = beforeIndex.get(workspace.id);
    if (previous === workspace) continue;
    const dirty = diffWorkspace(previous, workspace);
    if (dirty.length > 0) result.set(workspace.id, dirty);
  }

  // A workspace that disappeared locally. Reported so a caller can decide;
  // nothing here pushes a workspace deletion.
  for (const [id, workspace] of beforeIndex) {
    if (!after.workspaces.some((w) => w.id === id)) {
      result.set(id, diffWorkspace(workspace, undefined));
    }
  }

  return result;
}

/**
 * Turns dirty refs plus the current workspace into the upserts and deletes a
 * push carries.
 *
 * Reading the payload from CURRENT state rather than from a recorded delta
 * is what makes a retry safe: whatever the server ends up with is whatever
 * the client currently holds, however many times the request is repeated.
 *
 * A dirty id that no longer exists in the workspace becomes a delete. A
 * dirty id that exists becomes an upsert of its present state.
 */
export function buildPush(
  workspace: Workspace,
  dirty: readonly DirtyRef[],
  /** This workspace's collections. Their own store, so they arrive separately. */
  collections: readonly Collection[] = [],
  /** The flat dependency store. Filtered to this workspace's tabs below. */
  dependencies: readonly TabDependency[] = []
): { upserts: SyncUpsert[]; deletes: SyncEntityRef[] } {
  const upserts: SyncUpsert[] = [];
  const deletes: SyncEntityRef[] = [];

  const sections = indexById(workspace.sections);
  const groups = indexById(workspace.groups);
  const tabs = indexById(workspace.tabs);
  const collectionsById = indexById(collections);
  const dependenciesByPair = new Map(
    dependencies.map((dependency) => [`${dependency.parentTabId}::${dependency.childTabId}`, dependency])
  );

  for (const entry of dirty) {
    const { ref } = entry;
    if (ref.entityType === "dependency") {
      // Identity is the pair, so the lookup is by pair rather than by id.
      // Absent from current state means it was removed, whatever the event
      // said — current state is what the push describes.
      const dependency = dependenciesByPair.get(`${ref.parentTabId}::${ref.childTabId}`);
      if (!dependency || entry.deleted) deletes.push(ref);
      else upserts.push({ entityType: "dependency", entity: toDependencyPayload(dependency) });
      continue;
    }

    if (ref.entityType === "collection") {
      const collection = collectionsById.get(ref.entityId);
      if (!collection || entry.deleted) deletes.push(ref);
      // Membership travels inside the collection's payload — it is not
      // separately versioned (see schema.sql), so sending the collection
      // sends its current tab list.
      else upserts.push({ entityType: "collection", entity: toCollectionPayload(collection) });
      continue;
    }

    if (ref.entityType === "workspace") {
      if (!entry.deleted) upserts.push({ entityType: "workspace", entity: toWorkspacePayload(workspace) });
      continue;
    }

    if (ref.entityType === "section") {
      const section = sections.get(ref.entityId);
      if (section) upserts.push({ entityType: "section", entity: toSectionPayload(section) });
      else deletes.push(ref);
      continue;
    }

    if (ref.entityType === "group") {
      const group = groups.get(ref.entityId);
      if (group) upserts.push({ entityType: "group", entity: toGroupPayload(group) });
      else deletes.push(ref);
      continue;
    }

    if (ref.entityType === "tab") {
      const tab = tabs.get(ref.entityId);
      if (tab) upserts.push({ entityType: "tab", entity: toTabPayload(tab) });
      else deletes.push(ref);
      continue;
    }
  }

  // Sections and groups before tabs, so a tab's references exist server-side
  // before the tab that points at them. Mirrors buildWorkspaceUpserts.
  const order: Record<string, number> = { workspace: 0, section: 1, group: 2, tab: 3, collection: 4, dependency: 5 };
  upserts.sort((a, b) => order[a.entityType] - order[b.entityType]);

  return { upserts, deletes };
}
