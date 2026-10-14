import { readWorkspaceBrief } from "@/lib/workspace/brief";
import type { Collection } from "@/lib/collections/types";
import type { DependencyType, TabDependency } from "@/lib/dependencies/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import { readTabResource } from "@/lib/resources/read";

import type { TabResource } from "@/lib/resources/types";

/**
 * One project (workspace), copied and bounded: what the workspace reasoning
 * tools (insight, topics, relevance, plan) work over.
 *
 * ## Built on one side, read strictly on the other
 *
 * `buildWorkspaceSnapshot` copies an allowlist of fields from the app's own
 * data and applies the bounds. `readWorkspaceSnapshot` does not trust its
 * input: it re-reads the shape field by field, drops anything unknown,
 * re-applies every bound, and refuses a snapshot of any workspace other than
 * the one expected. A favicon or logo — data URLs, not knowledge — never
 * crosses.
 */

export const SNAPSHOT_LIMITS = {
  tabs: 800,
  collections: 200,
  collectionTabIds: 800,
  dependencies: 2000,
  /** Ids, urls, titles. */
  text: 2048,
  /** Notes are the user's own words and can be long; the resolver shows them only when asked. */
  notes: 500,
  name: 200,
  /** Encoded size; tabs are dropped from the end until it fits. */
  bytes: 800 * 1024,
} as const;

export type WorkspaceSnapshot = {
  workspace: Workspace;
  collections: Collection[];
  dependencies: TabDependency[];
  /** Tabs were left out to stay within the bounds. Answers built from it say so. */
  truncated: boolean;
};

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

const TAB_TEXT_FIELDS = ["title", "category", "groupId", "sectionId"] as const;
const TAB_TIME_FIELDS = ["createdAt", "updatedAt", "lastAccessedAt"] as const;

function text(value: unknown, max: number = SNAPSHOT_LIMITS.text): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function copyTab(raw: unknown): Tab | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 200);
  const url = text(source.url);
  const normalizedUrl = text(source.normalizedUrl);
  const domain = text(source.domain, 300);
  if (!id || !url || !normalizedUrl || !domain) return undefined;

  const tab: Tab = { id, url, normalizedUrl, domain };
  for (const field of TAB_TEXT_FIELDS) {
    const value = text(source[field], field === "title" ? SNAPSHOT_LIMITS.text : 200);
    if (value) tab[field] = value;
  }
  for (const field of TAB_TIME_FIELDS) {
    const value = time(source[field]);
    if (value !== undefined) tab[field] = value;
  }
  const notes = text(source.notes, SNAPSHOT_LIMITS.notes);
  if (notes) tab.notes = notes;
  if (source.pinned === true) tab.pinned = true;
  if (source.isFavorite === true) tab.isFavorite = true;
  if (source.source === "tabs" || source.source === "history") tab.source = source.source;
  const resource = copyResource(source.resource);
  if (resource) tab.resource = resource;
  return tab;
}

/**
 * A source's description as a reader may see it: what it is, whether Hubble
 * could read it and why not — without the uploaded file's name or size,
 * which describe the person's disk rather than the source.
 */
function copyResource(raw: unknown): TabResource | undefined {
  const resource = readTabResource(raw);
  if (!resource) return undefined;
  const meta = resource.meta;
  const kept = meta
    ? Object.fromEntries(
        Object.entries({ siteName: meta.siteName, author: meta.author, publishedAt: meta.publishedAt, pageCount: meta.pageCount, durationSeconds: meta.durationSeconds, mimeType: meta.mimeType }).filter(([, value]) => value !== undefined)
      )
    : undefined;
  const copy: TabResource = { ...resource };
  delete copy.meta;
  if (kept && Object.keys(kept).length > 0) copy.meta = kept;
  return copy;
}

const DEPENDENCY_TYPES: readonly DependencyType[] = [
  "main-document",
  "research",
  "data-source",
  "reference",
  "tool",
  "other",
];

function copyDependency(raw: unknown, tabIds: ReadonlySet<string>): TabDependency | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 200);
  const parentTabId = text(source.parentTabId, 200);
  const childTabId = text(source.childTabId, 200);
  const createdAt = time(source.createdAt);
  if (!id || !parentTabId || !childTabId || createdAt === undefined) return undefined;
  // A relationship to a tab outside this snapshot points outside the project.
  if (!tabIds.has(parentTabId) || !tabIds.has(childTabId)) return undefined;
  const dependency: TabDependency = { id, parentTabId, childTabId, createdAt };
  if (typeof source.type === "string" && (DEPENDENCY_TYPES as readonly string[]).includes(source.type)) {
    dependency.type = source.type as DependencyType;
  }
  return dependency;
}

function copyCollection(raw: unknown, workspaceId: string, tabIds: ReadonlySet<string>): Collection | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 200);
  const name = text(source.name, SNAPSHOT_LIMITS.name);
  const createdAt = time(source.createdAt);
  const updatedAt = time(source.updatedAt);
  // Another project's collection is not this snapshot's to show.
  if (!id || !name || source.workspaceId !== workspaceId || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const members = Array.isArray(source.tabIds) ? source.tabIds : [];
  return {
    id,
    workspaceId,
    name,
    tabIds: members
      .filter((tabId): tabId is string => typeof tabId === "string" && tabIds.has(tabId))
      .slice(0, SNAPSHOT_LIMITS.collectionTabIds),
    createdAt,
    updatedAt,
  };
}

/**
 * Reads a snapshot, applying every bound, for exactly one workspace.
 *
 * Returns `undefined` for a snapshot of any other workspace.
 */
export function readWorkspaceSnapshot(
  raw: unknown,
  expectedWorkspaceId: string
): WorkspaceSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const workspaceRaw = source.workspace as Record<string, unknown> | undefined;
  if (!workspaceRaw || typeof workspaceRaw !== "object") return undefined;
  if (workspaceRaw.id !== expectedWorkspaceId) return undefined;

  const createdAt = time(workspaceRaw.createdAt);
  const updatedAt = time(workspaceRaw.updatedAt);
  if (createdAt === undefined || updatedAt === undefined) return undefined;

  const rawTabs = Array.isArray(workspaceRaw.tabs) ? workspaceRaw.tabs : [];
  const tabs: Tab[] = [];
  for (const entry of rawTabs) {
    if (tabs.length >= SNAPSHOT_LIMITS.tabs) break;
    const tab = copyTab(entry);
    if (tab && !tabs.some((existing) => existing.id === tab.id)) tabs.push(tab);
  }
  let truncated = source.truncated === true || rawTabs.length > tabs.length;

  const tabIds = new Set(tabs.map((tab) => tab.id));
  const collections = (Array.isArray(source.collections) ? source.collections : [])
    .map((entry) => copyCollection(entry, expectedWorkspaceId, tabIds))
    .filter((entry): entry is Collection => entry !== undefined)
    .slice(0, SNAPSHOT_LIMITS.collections);
  const dependencies = (Array.isArray(source.dependencies) ? source.dependencies : [])
    .map((entry) => copyDependency(entry, tabIds))
    .filter((entry): entry is TabDependency => entry !== undefined)
    .slice(0, SNAPSHOT_LIMITS.dependencies);

  // The brief (Hubble 1.5) is the user's own two lines, re-read with its own
  // bounds and credential scrub on this side too.
  const brief = readWorkspaceBrief(workspaceRaw.brief);
  const snapshot: WorkspaceSnapshot = {
    workspace: {
      id: expectedWorkspaceId,
      name: text(workspaceRaw.name, SNAPSHOT_LIMITS.name) ?? "Untitled workspace",
      tabs,
      ...(brief ? { brief } : {}),
      createdAt,
      updatedAt,
    },
    collections,
    dependencies,
    truncated,
  };
  // The byte budget, applied last: tabs from the end, until it fits.
  while (encodedSize(snapshot) > SNAPSHOT_LIMITS.bytes && snapshot.workspace.tabs.length > 0) {
    const keep = Math.floor(snapshot.workspace.tabs.length * 0.8);
    snapshot.workspace.tabs = snapshot.workspace.tabs.slice(0, keep);
    const kept = new Set(snapshot.workspace.tabs.map((tab) => tab.id));
    snapshot.collections = snapshot.collections.map((collection) => ({
      ...collection,
      tabIds: collection.tabIds.filter((tabId) => kept.has(tabId)),
    }));
    snapshot.dependencies = snapshot.dependencies.filter(
      (dependency) => kept.has(dependency.parentTabId) && kept.has(dependency.childTabId)
    );
    truncated = true;
    snapshot.truncated = true;
  }
  return snapshot;
}

function encodedSize(snapshot: WorkspaceSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).length;
}

/**
 * The snapshot of one workspace from the app's own data.
 * `undefined` when the workspace does not exist.
 */
export function buildWorkspaceSnapshot(
  world: {
    workspaces: readonly Workspace[];
    collections: readonly Collection[];
    dependencies: readonly TabDependency[];
  },
  workspaceId: string
): WorkspaceSnapshot | undefined {
  const workspace = world.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return undefined;
  const tabIds = new Set(workspace.tabs.map((tab) => tab.id));
  return readWorkspaceSnapshot(
    {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        tabs: workspace.tabs,
        ...(workspace.brief ? { brief: workspace.brief } : {}),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
      collections: world.collections.filter((collection) => collection.workspaceId === workspaceId),
      dependencies: world.dependencies.filter(
        (dependency) => tabIds.has(dependency.parentTabId) && tabIds.has(dependency.childTabId)
      ),
    },
    workspaceId
  );
}
