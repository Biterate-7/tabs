import { addTabsToCollection, createCollection, renameCollection } from "./relations";
import { createTimestamp } from "@/lib/timestamps";
import type { Collection } from "./types";

/**
 * Several collection changes applied as one (Phase J.5).
 *
 * ## All or nothing
 *
 * The collection store is a pure reducer over one array, so a batch does not
 * need a transaction engine: every operation is checked against the state
 * the operations before it produced, folded through the same reducers the
 * workspace view uses (./relations.ts), and only a batch in which *every*
 * operation holds returns a new array. The caller commits that array in one
 * write. A batch that fails at operation 3 returns nothing to commit —
 * operations 1 and 2 never happened — and says which one failed and why.
 *
 * ## What a batch can do
 *
 * Exactly the three things an agent may propose, each already an operation a
 * person makes by hand: create a collection (optionally seeded with tabs),
 * rename one, add tabs to one. Nothing here deletes a collection, removes a
 * tab or touches another workspace: a batch is scoped to one workspace, and
 * every tab and collection it names must be that workspace's.
 */

export type CollectionBatchOperation =
  | { kind: "create_collection"; name: string; tabIds: readonly string[] }
  | { kind: "rename_collection"; collectionId: string; name: string }
  | { kind: "add_tabs_to_collection"; collectionId: string; tabIds: readonly string[] };

export type CollectionBatchFailure = "unknown_tab" | "unknown_collection" | "empty_name" | "no_tabs" | "unknown_kind";

export type CollectionBatchResult =
  | {
      ok: true;
      collections: Collection[];
      /** The id of each collection created, in operation order. */
      created: string[];
      /** Every collection whose record changed, including ones tabs moved out of. */
      touched: string[];
    }
  | { ok: false; failedAt: number; reason: CollectionBatchFailure };

export function applyCollectionBatch(
  collections: readonly Collection[],
  scope: { workspaceId: string; tabIds: ReadonlySet<string> },
  operations: readonly CollectionBatchOperation[],
  now: number = createTimestamp()
): CollectionBatchResult {
  let state = [...collections];
  const created: string[] = [];
  const touched = new Set<string>();

  const ownCollection = (collectionId: string) =>
    state.find((collection) => collection.id === collectionId && collection.workspaceId === scope.workspaceId);

  /** A tab leaving its collection changes that collection's record too. */
  function noteHolders(tabIds: readonly string[]): void {
    const moving = new Set(tabIds);
    for (const collection of state) if (collection.tabIds.some((tabId) => moving.has(tabId))) touched.add(collection.id);
  }

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    switch (operation.kind) {
      case "create_collection": {
        const name = operation.name.trim();
        if (!name) return { ok: false, failedAt: index, reason: "empty_name" };
        if (operation.tabIds.length === 0) return { ok: false, failedAt: index, reason: "no_tabs" };
        if (!operation.tabIds.every((tabId) => scope.tabIds.has(tabId))) return { ok: false, failedAt: index, reason: "unknown_tab" };
        noteHolders(operation.tabIds);
        const result = createCollection(state, scope.workspaceId, name, [...operation.tabIds], now);
        state = result.collections;
        created.push(result.collection.id);
        touched.add(result.collection.id);
        break;
      }
      case "rename_collection": {
        const name = operation.name.trim();
        if (!name) return { ok: false, failedAt: index, reason: "empty_name" };
        if (!ownCollection(operation.collectionId)) return { ok: false, failedAt: index, reason: "unknown_collection" };
        state = renameCollection(state, operation.collectionId, name, now);
        touched.add(operation.collectionId);
        break;
      }
      case "add_tabs_to_collection": {
        if (!ownCollection(operation.collectionId)) return { ok: false, failedAt: index, reason: "unknown_collection" };
        if (operation.tabIds.length === 0) return { ok: false, failedAt: index, reason: "no_tabs" };
        if (!operation.tabIds.every((tabId) => scope.tabIds.has(tabId))) return { ok: false, failedAt: index, reason: "unknown_tab" };
        noteHolders(operation.tabIds);
        state = addTabsToCollection(state, operation.collectionId, [...operation.tabIds], now);
        touched.add(operation.collectionId);
        break;
      }
      default:
        // A kind this module does not know is never guessed at.
        return { ok: false, failedAt: index, reason: "unknown_kind" };
    }
  }

  return { ok: true, collections: state, created, touched: [...touched] };
}
