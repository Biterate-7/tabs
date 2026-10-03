import type { Collection } from "./types";

/**
 * Putting one workspace's collections back exactly as they were — the inverse
 * of an applied change, known rather than guessed.
 *
 * ## Why a snapshot, and why it is guarded
 *
 * Every agent change is applied as one batch (./batch.ts), so the workspace's
 * collections immediately before and immediately after it are both in hand.
 * Restoring `previous` is then the exact inverse — a created collection
 * removed, a rename reverted, added tabs returned to wherever they were —
 * with no reconstruction from the change's description.
 *
 * That holds only while the workspace still holds exactly what the change
 * left (`expected`). Anything edited since — by the person or another agent —
 * means restoring would silently discard that later work, so the restore is
 * refused and nothing moves. Refusal is the safe failure: the workspace is
 * never left half-restored.
 *
 * Pure, so the collection store and the landing page's demo undo through the
 * same function.
 */

export type CollectionRestore = {
  collections: Collection[];
  /** Collections whose record differs after the restore — re-created or reverted. */
  changed: string[];
  /** Collections the restore removes: the ones the change created. */
  removed: string[];
};

function inWorkspace(collections: readonly Collection[], workspaceId: string): Collection[] {
  return collections.filter((collection) => collection.workspaceId === workspaceId);
}

/** Whether `workspaceId`'s collections are still exactly `expected` — the only state a restore may start from. */
export function collectionsMatch(
  collections: readonly Collection[],
  workspaceId: string,
  expected: readonly Collection[]
): boolean {
  return JSON.stringify(inWorkspace(collections, workspaceId)) === JSON.stringify(expected);
}

/**
 * `collections` with `workspaceId`'s replaced by `previous`, or `null` when
 * the workspace has moved on from `expected` (nothing is changed). Every other
 * workspace's collections are left exactly as they are.
 */
export function restoreWorkspaceCollections(
  collections: readonly Collection[],
  workspaceId: string,
  previous: readonly Collection[],
  expected: readonly Collection[]
): CollectionRestore | null {
  if (previous.some((collection) => collection.workspaceId !== workspaceId)) return null;
  if (!collectionsMatch(collections, workspaceId, expected)) return null;
  const current = inWorkspace(collections, workspaceId);
  const before = new Map(previous.map((collection) => [collection.id, JSON.stringify(collection)]));
  const now = new Map(current.map((collection) => [collection.id, JSON.stringify(collection)]));
  return {
    collections: [...collections.filter((collection) => collection.workspaceId !== workspaceId), ...previous],
    changed: [...before.keys()].filter((id) => before.get(id) !== now.get(id)),
    removed: [...now.keys()].filter((id) => !before.has(id)),
  };
}
