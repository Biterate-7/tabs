import { getCollectionForTab } from "./relations";
import type { Collection } from "./types";

export type CollectionValidation =
  | { ok: true }
  | { ok: false; reason: "not-found" | "tab-not-found" | "wrong-workspace" | "duplicate" };

/**
 * UI-facing check used before adding/moving a tab into a collection — lets a
 * dialog disable/explain an invalid pick before committing to it, same role
 * dependencies/validation.ts's validateDependency plays for the dependency
 * dialog. `tabWorkspaceId` is the workspace the tab currently lives in
 * (undefined if the tab doesn't exist at all) — resolved by the caller from
 * whatever workspace lookup it already has on hand.
 */
export function validateAddTabToCollection(
  collections: Collection[],
  collectionId: string,
  tabId: string,
  tabWorkspaceId: string | undefined
): CollectionValidation {
  const collection = collections.find((c) => c.id === collectionId);
  if (!collection) return { ok: false, reason: "not-found" };
  if (tabWorkspaceId === undefined) return { ok: false, reason: "tab-not-found" };
  if (tabWorkspaceId !== collection.workspaceId) return { ok: false, reason: "wrong-workspace" };
  if (collection.tabIds.includes(tabId)) return { ok: false, reason: "duplicate" };
  const existing = getCollectionForTab(collections, tabId);
  if (existing && existing.id === collectionId) return { ok: false, reason: "duplicate" };
  return { ok: true };
}
