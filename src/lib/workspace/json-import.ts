import { createId } from "@/lib/id";
import { dependencyId, mergeDependencies } from "@/lib/dependencies/relations";
import { DEPENDENCY_TYPE_ORDER } from "@/lib/dependencies/types";
import type { DependencyType, TabDependency } from "@/lib/dependencies/types";
import { EXPORT_VERSION } from "./json-export";
import type { Tab } from "@/lib/tabs/types";
import type { Group, Workspace } from "./types";

export type ImportResult =
  | {
      ok: true;
      workspaces: Workspace[];
      skippedWorkspaces: number;
      skippedTabs: number;
      dependencies: TabDependency[];
      skippedDependencies: number;
    }
  | { ok: false; reason: "invalid-json" | "invalid-schema" | "unsupported-version" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRawTab(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.url === "string" &&
    typeof value.normalizedUrl === "string" &&
    typeof value.domain === "string"
  );
}

/**
 * Sanitizes one workspace's tab list: drops entries that aren't at least
 * shaped like a `Tab`, and regenerates any id that's missing or collides
 * with one already seen in this same workspace — so a malformed or
 * hand-edited export can never produce two tabs sharing an id.
 *
 * `groupId` gets the same sanitize-don't-fail treatment as everything else
 * here: `groupIdMap` (built by sanitizeGroups, keyed by each group's ORIGINAL
 * raw id) resolves a raw `groupId` to whatever final id that group actually
 * ended up with — a raw id that isn't a string, or doesn't match any group
 * that survived sanitizeGroups (missing groups array, malformed group,
 * dangling reference to a group that was never there), is silently dropped
 * rather than failing the whole tab, per AGENTS.md section 16.
 *
 * Also returns `idMap`, from each surviving tab's ORIGINAL raw id to
 * whatever final id it ended up with (mirrors sanitizeGroups's idMap) — used
 * by parseWorkspaceExport to remap a dependency's parentTabId/childTabId so
 * a dependency survives an id regeneration intact, same as tab.groupId does.
 */
function sanitizeTabs(
  raw: unknown[],
  groupIdMap: Map<string, string>
): { tabs: Tab[]; skipped: number; idMap: Map<string, string> } {
  const tabs: Tab[] = [];
  const seenIds = new Set<string>();
  const idMap = new Map<string, string>();
  let skipped = 0;

  for (const entry of raw) {
    if (!isValidRawTab(entry)) {
      skipped += 1;
      continue;
    }

    const rawId = typeof entry.id === "string" ? entry.id : undefined;
    const id = !rawId || seenIds.has(rawId) ? createId("tab") : rawId;
    seenIds.add(id);
    if (rawId && !idMap.has(rawId)) idMap.set(rawId, id);

    const rawGroupId = typeof entry.groupId === "string" ? entry.groupId : undefined;
    const groupId = rawGroupId ? groupIdMap.get(rawGroupId) : undefined;

    const tab: Tab = { ...(entry as unknown as Tab), id };
    if (groupId) tab.groupId = groupId;
    else delete tab.groupId;

    tabs.push(tab);
  }

  return { tabs, skipped, idMap };
}

function isValidRawGroup(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value.name === "string" && value.name.trim().length > 0;
}

/**
 * Sanitizes one workspace's `groups`, mirroring sanitizeTabs: drops entries
 * that aren't at least shaped like a `Group`, and regenerates any id that's
 * missing or collides with one already seen in this same workspace.
 * `groups` itself is optional on Workspace (older exports never had it), so
 * a missing or wrong-typed field here isn't an error — it just means "no
 * groups," not "malformed workspace."
 *
 * Also returns `idMap`, from each surviving group's ORIGINAL raw id to
 * whatever final id it ended up with (same id, unless it collided with one
 * already seen) — sanitizeTabs uses this to resolve `tab.groupId`
 * references so a tab→group link survives an id regeneration intact.
 */
function sanitizeGroups(raw: unknown): { groups: Group[] | undefined; skipped: number; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  if (!Array.isArray(raw)) return { groups: undefined, skipped: 0, idMap };

  const groups: Group[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;
  const now = Date.now();

  for (const entry of raw) {
    if (!isValidRawGroup(entry)) {
      skipped += 1;
      continue;
    }

    const rawId = typeof entry.id === "string" ? entry.id : undefined;
    const id = !rawId || seenIds.has(rawId) ? createId("group") : rawId;
    seenIds.add(id);
    // Only the FIRST entry claiming a given raw id gets to own that id in
    // the map — a later entry that collided with it (and so got a freshly
    // minted id instead) must not clobber the mapping a `tab.groupId`
    // reference to the original raw id resolves to.
    if (rawId && !idMap.has(rawId)) idMap.set(rawId, id);

    groups.push({
      id,
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
    });
  }

  return { groups, skipped, idMap };
}

/**
 * Always mints a fresh workspace id, regardless of what the export carried —
 * this is what guarantees an import can never collide with (and so can
 * never overwrite) a workspace already in the store.
 */
function sanitizeWorkspace(
  raw: unknown
): { workspace: Workspace; skippedTabs: number; skippedGroups: number; tabIdMap: Map<string, string> } | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.tabs)) return null;

  const { groups, skipped: skippedGroups, idMap: groupIdMap } = sanitizeGroups(raw.groups);
  const { tabs, skipped, idMap: tabIdMap } = sanitizeTabs(raw.tabs, groupIdMap);
  const now = Date.now();

  const workspace: Workspace = {
    id: createId("workspace"),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Untitled",
    tabs,
    ...(groups !== undefined ? { groups } : {}),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
  };

  return { workspace, skippedTabs: skipped, skippedGroups, tabIdMap };
}

function isValidRawDependency(
  value: unknown
): value is { parentTabId: string; childTabId: string } & Record<string, unknown> {
  return (
    isPlainObject(value) &&
    typeof value.parentTabId === "string" &&
    typeof value.childTabId === "string"
  );
}

function sanitizeType(value: unknown): DependencyType | undefined {
  return typeof value === "string" && (DEPENDENCY_TYPE_ORDER as string[]).includes(value)
    ? (value as DependencyType)
    : undefined;
}

/**
 * Resolves each raw dependency's parentTabId/childTabId through `tabIdMap`
 * (the combined original-id → final-id map across every workspace in this
 * import) so a dependency survives even when its referenced tab's id was
 * regenerated on import (a missing id, or a collision — see sanitizeTabs).
 * A reference to a tab id that isn't in the map at all (the tab was dropped
 * as malformed, or never existed) is silently skipped rather than failing
 * the import — same "sanitize, don't fail" contract as everything else
 * here. Ids are always reminted via dependencyId rather than trusting the
 * raw id, since a dependency's identity is its (parent, child) pair, not
 * whatever string happened to be in the file.
 */
function sanitizeDependencies(
  raw: unknown,
  tabIdMap: Map<string, string>
): { dependencies: TabDependency[]; skipped: number } {
  if (!Array.isArray(raw)) return { dependencies: [], skipped: 0 };

  const dependencies: TabDependency[] = [];
  let skipped = 0;
  const now = Date.now();

  for (const entry of raw) {
    if (!isValidRawDependency(entry)) {
      skipped += 1;
      continue;
    }
    const parentTabId = tabIdMap.get(entry.parentTabId);
    const childTabId = tabIdMap.get(entry.childTabId);
    if (!parentTabId || !childTabId || parentTabId === childTabId) {
      skipped += 1;
      continue;
    }
    const merged = mergeDependencies(dependencies, [
      {
        id: dependencyId(parentTabId, childTabId),
        parentTabId,
        childTabId,
        type: sanitizeType(entry.type),
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
      },
    ]);
    if (merged.length === dependencies.length) {
      skipped += 1; // duplicate within this same import batch
      continue;
    }
    dependencies.push(merged[merged.length - 1]);
  }

  return { dependencies, skipped };
}

export function parseWorkspaceExport(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.workspaces)) {
    return { ok: false, reason: "invalid-schema" };
  }
  if (parsed.version !== EXPORT_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }

  const workspaces: Workspace[] = [];
  let skippedWorkspaces = 0;
  let skippedTabs = 0;
  // Combined across every workspace in this file — a dependency can point
  // from a tab in one exported workspace to a tab in another.
  const combinedTabIdMap = new Map<string, string>();

  for (const entry of parsed.workspaces) {
    const sanitized = sanitizeWorkspace(entry);
    if (!sanitized) {
      skippedWorkspaces += 1;
      continue;
    }
    workspaces.push(sanitized.workspace);
    skippedTabs += sanitized.skippedTabs;
    for (const [rawId, finalId] of sanitized.tabIdMap) {
      if (!combinedTabIdMap.has(rawId)) combinedTabIdMap.set(rawId, finalId);
    }
  }

  const { dependencies, skipped: skippedDependencies } = sanitizeDependencies(
    parsed.dependencies,
    combinedTabIdMap
  );

  return { ok: true, workspaces, skippedWorkspaces, skippedTabs, dependencies, skippedDependencies };
}
