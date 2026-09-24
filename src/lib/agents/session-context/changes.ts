/**
 * The workspace changes an agent session may propose (Phase J.3–J.4).
 *
 * ## Three, each an existing collection-store operation
 *
 *   create_collection       → createCollection      (tabs move out of any other collection)
 *   rename_collection       → renameCollection      (reversible: rename it back)
 *   add_tabs_to_collection  → addTabsToCollection   (tabs move out of any other collection)
 *
 * Each is an operation the workspace view already offers a person, applied
 * by the Command Centre through the same store — the runtime and the MCP
 * server never touch workspace data. Nothing here deletes: no tab, no
 * collection, no relationship can be removed by an agent.
 *
 * A change is proposed, approved by the user (every time, through the
 * control service's broker), and only then applied. The summary below is how
 * it is shown on the approval card: names and titles, never ids.
 */

export type WorkspaceChangeKind = "create_collection" | "rename_collection" | "add_tabs_to_collection";

export const WORKSPACE_CHANGE_KINDS: readonly WorkspaceChangeKind[] = [
  "create_collection",
  "rename_collection",
  "add_tabs_to_collection",
] as const;

export function isWorkspaceChangeKind(value: unknown): value is WorkspaceChangeKind {
  return typeof value === "string" && (WORKSPACE_CHANGE_KINDS as readonly string[]).includes(value);
}

export type WorkspaceChange =
  | { kind: "create_collection"; name: string; tabIds: readonly string[] }
  | { kind: "rename_collection"; collectionId: string; name: string }
  | { kind: "add_tabs_to_collection"; collectionId: string; tabIds: readonly string[] };

/** A change as a person reads it. Plain text only; bounded; no ids. */
export type WorkspaceChangeSummary = {
  kind: WorkspaceChangeKind;
  /** The collection the change is about, by name: the new one, or the one renamed or added to. */
  subject: string;
  /** For a rename, the new name. */
  to?: string;
  /** How many tabs the change places in the collection, when it places any. */
  tabCount?: number;
  /** A few lines of detail: sample tab titles, collections tabs would move out of. */
  details: readonly string[];
};

/** How the approval card completes "<Agent> wants to …". */
export const WORKSPACE_CHANGE_HEADLINE: Record<WorkspaceChangeKind, string> = {
  create_collection: "create a collection",
  rename_collection: "rename a collection",
  add_tabs_to_collection: "add tabs to a collection",
};

export const CHANGE_LIMITS = {
  name: 80,
  tabs: 200,
  subject: 120,
  detail: 160,
  details: 6,
} as const;

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * Reads a summary strictly, applying every bound. `undefined` for anything
 * malformed — a card that cannot be shown truthfully is not shown at all.
 */
export function readWorkspaceChangeSummary(raw: unknown): WorkspaceChangeSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (!isWorkspaceChangeKind(source.kind)) return undefined;
  const subject = clean(source.subject, CHANGE_LIMITS.subject);
  if (!subject) return undefined;
  const to = clean(source.to, CHANGE_LIMITS.subject);
  if (source.kind === "rename_collection" && !to) return undefined;
  const tabCount =
    typeof source.tabCount === "number" && Number.isInteger(source.tabCount) && source.tabCount >= 0 && source.tabCount <= 10_000
      ? source.tabCount
      : undefined;
  const details = (Array.isArray(source.details) ? source.details : [])
    .map((line) => clean(line, CHANGE_LIMITS.detail))
    .filter((line): line is string => line !== undefined)
    .slice(0, CHANGE_LIMITS.details);
  return {
    kind: source.kind,
    subject,
    ...(to && source.kind === "rename_collection" ? { to } : {}),
    ...(tabCount !== undefined ? { tabCount } : {}),
    details,
  };
}

/** Normalizes a proposed collection name. Empty after cleaning means invalid. */
export function cleanCollectionName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, CHANGE_LIMITS.name);
}
