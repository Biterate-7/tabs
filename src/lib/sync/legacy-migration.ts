/**
 * Rewriting a workspace that still carries pre-UUID entity ids so it can be
 * uploaded.
 *
 * Phase 1 (63992f8) switched id generation to UUIDs but deliberately left
 * existing stored ids alone — `ws-1699123456789-1` and friends still exist
 * on disk and still work locally. Phase 3's schema uses real UUID columns
 * and its validation rejects anything else, so such a workspace cannot be
 * uploaded as it stands.
 *
 * This module produces a NEW representation. It never mutates its input and
 * never writes anything: the caller holds the original until the server has
 * confirmed the rewritten copy, which is what makes a failed upload a
 * no-op rather than a half-migrated workspace.
 *
 *
 * ## The whole-graph rule
 *
 * An id is remapped everywhere or nowhere. A partial remap is worse than no
 * remap: a tab whose `sectionId` still points at a section that has been
 * renumbered is a dangling reference, and the schema's composite foreign
 * keys would reject it — after the rest of the workspace had already been
 * accepted, if this were done piecemeal. So the mapping for every entity is
 * built first, from the complete workspace, and only then is anything
 * rewritten.
 *
 * References rewritten: tab.sectionId, tab.groupId, section.parentId,
 * collection.workspaceId, collection.tabIds, dependency.parentTabId,
 * dependency.childTabId, and the tab/workspace ids embedded in device-local
 * graph state (positions, boundaryOffsets, manualConnections,
 * settings.workspaceFilter, settings.selectedTabId).
 *
 * Graph state is included even though it never syncs. Its keys are tab ids;
 * renumbering the tabs without it would silently discard the user's saved
 * layout, which is their work.
 *
 *
 * ## Identity is the id, never the URL
 *
 * Two tabs with the same URL are two tabs. TabDump has first-class duplicate
 * semantics (`isDuplicate`, markDuplicates) and a user may legitimately keep
 * the same page in several sections. Nothing here groups, dedupes or merges
 * by URL, and a test pins that.
 *
 *
 * ## Idempotency
 *
 * A workspace whose ids are already UUIDs maps every id to itself and comes
 * back unchanged (`migrated: false`). Running this twice therefore produces
 * the same result as running it once, which is what lets a retry after a
 * lost response be safe.
 */

import { createId } from "@/lib/id";
import { isUuid } from "./validation";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { GraphPersistedState } from "@/lib/graph/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * old id → new id for every persistent entity in one workspace.
 *
 * Ids that are already UUIDs map to themselves, so callers never need to ask
 * "was this one remapped?" — they just look it up.
 */
export type LegacyIdMap = ReadonlyMap<string, string>;

export type LegacyMigrationInput = {
  workspace: Workspace;
  /** Collections belonging to this workspace. Collections live in their own store keyed by workspaceId. */
  collections: readonly Collection[];
  /** Dependencies whose endpoints are both tabs of this workspace. The dependency store is flat and global. */
  dependencies: readonly TabDependency[];
  /** Device-local graph state, remapped so a saved layout survives. Optional: a workspace may have none. */
  graph?: GraphPersistedState;
};

export type LegacyMigrationResult = {
  /** False when every id was already a UUID — the input is returned untouched. */
  migrated: boolean;
  /** Complete old → new mapping, including identity entries for ids that were already UUIDs. */
  idMap: LegacyIdMap;
  workspace: Workspace;
  collections: Collection[];
  dependencies: TabDependency[];
  graph?: GraphPersistedState;
  /** Ids that were neither a UUID nor a recognisable legacy id — see `unmappable` below. */
  unmappableIds: string[];
};

/**
 * Maps one id, minting a UUID the first time a non-UUID id is seen.
 *
 * `createId()` is the same generator the rest of the app uses — this does
 * not invent a second identity scheme, and the ids it produces are ordinary
 * client-generated UUIDs indistinguishable from any other.
 */
function mapId(id: string, into: Map<string, string>): string {
  const existing = into.get(id);
  if (existing) return existing;
  const next = isUuid(id) ? id : createId();
  into.set(id, next);
  return next;
}

/** Resolves a reference through the map. An unknown reference is left as-is and reported rather than silently dropped. */
function resolve(id: string | undefined, map: Map<string, string>, unmappable: Set<string>): string | undefined {
  if (id === undefined) return undefined;
  const mapped = map.get(id);
  if (mapped) return mapped;
  // A reference to an entity that is not in this workspace. Rewriting it to
  // something invented would be a guess; dropping it would be data loss. It
  // is carried through unchanged and surfaced, so validation refuses the
  // upload with a precise reason rather than the database rejecting it later.
  if (!isUuid(id)) unmappable.add(id);
  return id;
}

export function buildLegacyIdMap(input: LegacyMigrationInput): LegacyIdMap {
  const map = new Map<string, string>();

  // Order matters only for readability — every id is registered before any
  // reference is resolved, which is the property that makes the rewrite
  // below total.
  mapId(input.workspace.id, map);
  for (const section of input.workspace.sections ?? []) mapId(section.id, map);
  for (const group of input.workspace.groups ?? []) mapId(group.id, map);
  for (const tab of input.workspace.tabs) mapId(tab.id, map);
  for (const collection of input.collections) mapId(collection.id, map);

  return map;
}

/** Whether anything in this workspace needs rewriting before it can be uploaded. */
export function needsLegacyMigration(input: LegacyMigrationInput): boolean {
  const map = buildLegacyIdMap(input);
  for (const [from, to] of map) {
    if (from !== to) return true;
  }
  return false;
}

export function migrateLegacyWorkspace(input: LegacyMigrationInput): LegacyMigrationResult {
  const map = new Map(buildLegacyIdMap(input));
  const unmappable = new Set<string>();

  let changed = false;
  for (const [from, to] of map) {
    if (from !== to) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    // Already all UUIDs. Returning the input by reference is deliberate: an
    // idempotent second run must be observably a no-op, not a deep copy that
    // merely compares equal.
    return {
      migrated: false,
      idMap: map,
      workspace: input.workspace,
      collections: [...input.collections],
      dependencies: [...input.dependencies],
      graph: input.graph,
      unmappableIds: [],
    };
  }

  const workspaceId = map.get(input.workspace.id)!;

  const sections = input.workspace.sections?.map((section) => ({
    ...section,
    id: map.get(section.id)!,
    // A root section's parentId is null and stays null.
    parentId: section.parentId === null ? null : (resolve(section.parentId, map, unmappable) ?? null),
  }));

  const groups = input.workspace.groups?.map((group) => ({ ...group, id: map.get(group.id)! }));

  const tabs: Tab[] = input.workspace.tabs.map((tab) => {
    // Spread first so every field this module does not know about — present
    // and future — survives untouched. Only ids are rewritten.
    const next: Tab = { ...tab, id: map.get(tab.id)! };
    // `in` rather than `!== undefined`: an absent sectionId must stay absent
    // rather than becoming an explicit undefined key.
    if ("sectionId" in tab) {
      const sectionId = resolve(tab.sectionId, map, unmappable);
      if (sectionId === undefined) delete next.sectionId;
      else next.sectionId = sectionId;
    }
    if ("groupId" in tab) {
      const groupId = resolve(tab.groupId, map, unmappable);
      if (groupId === undefined) delete next.groupId;
      else next.groupId = groupId;
    }
    return next;
  });

  const workspace: Workspace = {
    ...input.workspace,
    id: workspaceId,
    tabs,
    ...(sections ? { sections } : {}),
    ...(groups ? { groups } : {}),
  };

  const collections: Collection[] = input.collections.map((collection) => ({
    ...collection,
    id: map.get(collection.id)!,
    workspaceId,
    // Membership order is preserved exactly; nothing is deduped.
    tabIds: collection.tabIds.map((id) => resolve(id, map, unmappable)!),
  }));

  const dependencies: TabDependency[] = input.dependencies.map((dependency) => {
    const parentTabId = resolve(dependency.parentTabId, map, unmappable)!;
    const childTabId = resolve(dependency.childTabId, map, unmappable)!;
    return {
      ...dependency,
      // The client derives a dependency's id from its pair, so the id has to
      // be rebuilt from the NEW ids rather than carried across — a stale
      // `dep-<old>::<old>` would disagree with the columns beside it.
      id: `dep-${parentTabId}::${childTabId}`,
      parentTabId,
      childTabId,
    };
  });

  const graph = input.graph ? migrateGraphState(input.graph, map, unmappable) : undefined;

  return {
    migrated: true,
    idMap: map,
    workspace,
    collections,
    dependencies,
    graph,
    unmappableIds: [...unmappable],
  };
}

/**
 * Rewrites the tab and workspace ids embedded in device-local graph state.
 *
 * Entries keyed by an id this workspace does not own are dropped rather than
 * carried: the graph store is global across workspaces, and its own prune
 * (pruneGraphState) already removes positions for tabs that no longer exist,
 * so keeping an unresolvable key would only recreate the stale entry the
 * prune exists to delete.
 */
function migrateGraphState(
  graph: GraphPersistedState,
  map: Map<string, string>,
  unmappable: Set<string>
): GraphPersistedState {
  const remapRecord = <T>(record: Record<string, T>): Record<string, T> => {
    const next: Record<string, T> = {};
    for (const [id, value] of Object.entries(record)) {
      const mapped = map.get(id);
      if (mapped) next[mapped] = value;
      else next[id] = value;
    }
    return next;
  };

  const manualConnections = graph.manualConnections.map((connection) => ({
    ...connection,
    a: resolve(connection.a, map, unmappable) ?? connection.a,
    b: resolve(connection.b, map, unmappable) ?? connection.b,
  }));

  const workspaceFilter =
    graph.settings.workspaceFilter === "all"
      ? "all"
      : (map.get(graph.settings.workspaceFilter) ?? graph.settings.workspaceFilter);

  const selectedTabId =
    graph.settings.selectedTabId === null
      ? null
      : (map.get(graph.settings.selectedTabId) ?? graph.settings.selectedTabId);

  return {
    ...graph,
    positions: remapRecord(graph.positions),
    boundaryOffsets: remapRecord(graph.boundaryOffsets),
    manualConnections,
    settings: { ...graph.settings, workspaceFilter, selectedTabId },
  };
}
