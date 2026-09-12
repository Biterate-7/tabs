/**
 * Local domain objects → wire payloads, and back.
 *
 * The two representations are deliberately different. A local `Tab` carries
 * fields that are derived on the device (`normalizedUrl`, `domain`,
 * `isDuplicate`) or written but never read (`favicon`); Phase 3 decided none
 * of them sync, so they are dropped here rather than sent and ignored. See
 * schema.sql for the per-field reasoning.
 *
 * Everything in this file is pure. It reads no storage, makes no request and
 * touches no clock — which is what lets the round trip be tested exactly.
 */

import { isSafeOpenUrl } from "@/lib/browser/protocol";
import { normalizeUrl } from "@/lib/tabs/normalize";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";
import type { Group, Workspace } from "@/lib/workspace/types";
import type {
  CollectionSyncPayload,
  DependencySyncPayload,
  GroupSyncPayload,
  SectionSyncPayload,
  SyncUpsert,
  TabSyncPayload,
  WorkspaceSyncPayload,
} from "./types";

/** Drops undefined-valued keys, so an absent optional stays absent rather than serializing as null. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function toWorkspacePayload(workspace: Workspace): WorkspaceSyncPayload {
  return compact({
    id: workspace.id,
    name: workspace.name,
    logo: workspace.logo,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
}

export function toTabPayload(tab: Tab): TabSyncPayload {
  return compact({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    notes: tab.notes,
    category: tab.category,
    confidence: tab.confidence,
    isFavorite: tab.isFavorite,
    pinned: tab.pinned,
    sectionId: tab.sectionId,
    sectionLocked: tab.sectionLocked,
    organizationStatus: tab.organizationStatus,
    organizationReason: tab.organizationReason,
    groupId: tab.groupId,
    lastAccessedAt: tab.lastAccessedAt,
    source: tab.source,
    historyVisitCount: tab.historyVisitCount,
    historyLastVisitedAt: tab.historyLastVisitedAt,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  });
}

export function toSectionPayload(section: Section): SectionSyncPayload {
  return {
    id: section.id,
    parentId: section.parentId,
    name: section.name,
    source: section.source,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
}

export function toGroupPayload(group: Group): GroupSyncPayload {
  return { id: group.id, name: group.name, createdAt: group.createdAt, updatedAt: group.updatedAt };
}

export function toCollectionPayload(collection: Collection): CollectionSyncPayload {
  return {
    id: collection.id,
    name: collection.name,
    tabIds: [...collection.tabIds],
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

export function toDependencyPayload(dependency: TabDependency): DependencySyncPayload {
  return compact({
    parentTabId: dependency.parentTabId,
    childTabId: dependency.childTabId,
    type: dependency.type,
    createdAt: dependency.createdAt,
    updatedAt: dependency.updatedAt,
  });
}

/**
 * Every entity in a workspace, ordered so a receiver can apply them in
 * sequence: sections and groups exist before the tabs that reference them,
 * tabs before the collections and dependencies that point at them.
 *
 * Tabs carrying a URL the client would refuse to open are skipped rather
 * than sent. The server would reject them anyway (validation enforces
 * http(s)), and one such tab must not fail the whole upload — a workspace
 * that predates the scheme restriction can still hold one, and the user
 * should be able to sync everything else.
 */
export function buildWorkspaceUpserts(input: {
  workspace: Workspace;
  collections: readonly Collection[];
  dependencies: readonly TabDependency[];
}): SyncUpsert[] {
  const upserts: SyncUpsert[] = [];

  for (const section of input.workspace.sections ?? []) {
    upserts.push({ entityType: "section", entity: toSectionPayload(section) });
  }
  for (const group of input.workspace.groups ?? []) {
    upserts.push({ entityType: "group", entity: toGroupPayload(group) });
  }

  const syncableTabIds = new Set<string>();
  for (const tab of input.workspace.tabs) {
    if (!isSafeOpenUrl(tab.url)) continue;
    syncableTabIds.add(tab.id);
    upserts.push({ entityType: "tab", entity: toTabPayload(tab) });
  }

  for (const collection of input.collections) {
    // Membership is a foreign key server-side, so a reference to a tab that
    // was skipped above would be rejected. Dropping just that member keeps
    // the collection itself intact.
    const tabIds = collection.tabIds.filter((id) => syncableTabIds.has(id));
    upserts.push({ entityType: "collection", entity: { ...toCollectionPayload(collection), tabIds } });
  }

  for (const dependency of input.dependencies) {
    if (!syncableTabIds.has(dependency.parentTabId) || !syncableTabIds.has(dependency.childTabId)) continue;
    upserts.push({ entityType: "dependency", entity: toDependencyPayload(dependency) });
  }

  return upserts;
}

/**
 * A wire tab back into a local `Tab`, recomputing what the wire deliberately
 * omits.
 *
 * `normalizedUrl` and `domain` are derived here exactly as `toTab` derives
 * them locally (src/lib/tabs/parse.ts), so a tab that round-trips through
 * the server is indistinguishable from one that never left. `isDuplicate` is
 * not set: markDuplicates recomputes it across the whole list, and guessing
 * it for one tab in isolation would be wrong.
 *
 * Returns null for a URL that is not http(s). The server should never send
 * one — it validates on the way in — but a client must not trust that, and
 * dropping the tab is safer than importing something the app refuses to open.
 */
export function fromTabPayload(payload: TabSyncPayload): Tab | null {
  if (!isSafeOpenUrl(payload.url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(payload.url);
  } catch {
    return null;
  }
  return compact({
    ...payload,
    normalizedUrl: normalizeUrl(parsed),
    domain: parsed.hostname.replace(/^www\./, ""),
  }) as Tab;
}
