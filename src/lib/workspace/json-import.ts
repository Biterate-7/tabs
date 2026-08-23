import { createId } from "@/lib/id";
import { EXPORT_VERSION } from "./json-export";
import type { Tab } from "@/lib/tabs/types";
import type { Group, Workspace } from "./types";

export type ImportResult =
  | { ok: true; workspaces: Workspace[]; skippedWorkspaces: number; skippedTabs: number }
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
 */
function sanitizeTabs(raw: unknown[]): { tabs: Tab[]; skipped: number } {
  const tabs: Tab[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;

  for (const entry of raw) {
    if (!isValidRawTab(entry)) {
      skipped += 1;
      continue;
    }

    const rawId = typeof entry.id === "string" ? entry.id : undefined;
    const id = !rawId || seenIds.has(rawId) ? createId("tab") : rawId;
    seenIds.add(id);

    tabs.push({ ...(entry as unknown as Tab), id });
  }

  return { tabs, skipped };
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
 */
function sanitizeGroups(raw: unknown): { groups: Group[] | undefined; skipped: number } {
  if (!Array.isArray(raw)) return { groups: undefined, skipped: 0 };

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

    groups.push({
      id,
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
    });
  }

  return { groups, skipped };
}

/**
 * Always mints a fresh workspace id, regardless of what the export carried —
 * this is what guarantees an import can never collide with (and so can
 * never overwrite) a workspace already in the store.
 */
function sanitizeWorkspace(raw: unknown): { workspace: Workspace; skippedTabs: number; skippedGroups: number } | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.tabs)) return null;

  const { tabs, skipped } = sanitizeTabs(raw.tabs);
  const { groups, skipped: skippedGroups } = sanitizeGroups(raw.groups);
  const now = Date.now();

  const workspace: Workspace = {
    id: createId("workspace"),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Untitled",
    tabs,
    ...(groups !== undefined ? { groups } : {}),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
  };

  return { workspace, skippedTabs: skipped, skippedGroups };
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

  for (const entry of parsed.workspaces) {
    const sanitized = sanitizeWorkspace(entry);
    if (!sanitized) {
      skippedWorkspaces += 1;
      continue;
    }
    workspaces.push(sanitized.workspace);
    skippedTabs += sanitized.skippedTabs;
  }

  return { ok: true, workspaces, skippedWorkspaces, skippedTabs };
}
