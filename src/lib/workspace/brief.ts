import { scrubSecretShapes } from "@/lib/secret-shapes";
import type { Collection } from "@/lib/collections/types";
import type { Workspace, WorkspaceBrief, WorkspaceStore } from "./types";

/**
 * The workspace brief (Hubble 1.5): what a workspace is for and what is being
 * worked on in it now, in the user's own words — plus the facts Hubble can
 * count for itself.
 *
 *     Research
 *     Research and organize sources for the climate policy project.
 *     Current focus   Comparing carbon-pricing approaches.
 *     12 tabs · 3 collections · 4 recent changes
 *
 * ## Deliberately small
 *
 * Two optional lines and a time. No tags, no fields per resource, no rich
 * text, and nothing generated: a brief Hubble wrote would be a guess an agent
 * then treats as the user's intent. Everything else in the view below is
 * counted from the workspace itself, so it can never disagree with it.
 *
 * ## Agent-facing text, treated as such
 *
 * The brief reaches agents (the context pack and the session's workspace
 * summary). It is the user's prose, so it is held to one line each, stripped
 * of control characters, and scrubbed of anything shaped like a credential
 * with the same shapes the handoff instruction uses — before it is stored,
 * not only before it is sent.
 *
 * ## Local, like the rest of the workspace's organization
 *
 * Stored on the workspace in this browser's store. Sync carries a workspace's
 * name and logo field by field and leaves every other field where it is, so a
 * brief survives a pull on this device; it is not yet carried to another one.
 */

export const BRIEF_LIMITS = {
  description: 280,
  focus: 160,
} as const;

/**
 * One line of brief text as it may be kept: control characters and line
 * breaks become spaces, runs of space collapse, credentials are redacted, and
 * the result is bounded. `undefined` when nothing is left.
 */
export function readBriefText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = scrubSecretShapes(
    value
      .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** A stored brief, re-read field by field. `undefined`: nothing usable. */
export function readWorkspaceBrief(raw: unknown): WorkspaceBrief | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const description = readBriefText(source.description, BRIEF_LIMITS.description);
  const focus = readBriefText(source.focus, BRIEF_LIMITS.focus);
  if (!description && !focus) return undefined;
  const updatedAt =
    typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt) && source.updatedAt >= 0 ? source.updatedAt : 0;
  return { ...(description ? { description } : {}), ...(focus ? { focus } : {}), updatedAt };
}

export function isEmptyBrief(brief: Pick<WorkspaceBrief, "description" | "focus"> | undefined): boolean {
  return !brief?.description && !brief?.focus;
}

/**
 * Sets a workspace's brief. Both lines empty removes it, so a workspace with
 * no brief looks exactly like one that predates briefs. The same store comes
 * back when nothing changed.
 *
 * `updatedAt` on the workspace is left alone on purpose: it is what sync
 * pushes on, and the brief does not travel with a sync push.
 */
export function setWorkspaceBrief(
  store: WorkspaceStore,
  id: string,
  input: { description?: string; focus?: string },
  now: number = Date.now()
): WorkspaceStore {
  const description = readBriefText(input.description, BRIEF_LIMITS.description);
  const focus = readBriefText(input.focus, BRIEF_LIMITS.focus);
  let changed = false;
  const workspaces = store.workspaces.map((workspace) => {
    if (workspace.id !== id) return workspace;
    if (workspace.brief?.description === description && workspace.brief?.focus === focus) return workspace;
    changed = true;
    if (!description && !focus) {
      const copy = { ...workspace };
      delete copy.brief;
      return copy;
    }
    return {
      ...workspace,
      brief: { ...(description ? { description } : {}), ...(focus ? { focus } : {}), updatedAt: now },
    };
  });
  return changed ? { ...store, workspaces } : store;
}

/* ------------------------------------------------------------------ *
 * The brief as every surface shows it
 * ------------------------------------------------------------------ */

export type WorkspaceBriefView = {
  workspaceId: string;
  name: string;
  description?: string;
  focus?: string;
  tabs: number;
  collections: number;
  /** Agent changes applied in this workspace and not undone, as the caller counted them. */
  recentChanges: number;
  /** The largest collections, by tab count — the ones worth naming. */
  importantCollections: readonly { id: string; name: string; tabs: number }[];
};

/** How many collections a brief names. */
export const IMPORTANT_COLLECTIONS = 3;

/**
 * The brief of one workspace, from live state. Deterministic: the same
 * workspace and collections always describe the same way, whatever order
 * the collections arrived in.
 */
export function describeWorkspaceBrief(input: {
  workspace: Pick<Workspace, "id" | "name" | "tabs" | "brief">;
  collections: readonly Pick<Collection, "id" | "workspaceId" | "name" | "tabIds">[];
  recentChanges?: number;
}): WorkspaceBriefView {
  const { workspace } = input;
  const tabIds = new Set(workspace.tabs.map((tab) => tab.id));
  const own = input.collections
    .filter((collection) => collection.workspaceId === workspace.id)
    .map((collection) => ({
      id: collection.id,
      name: collection.name.trim() || "Untitled collection",
      tabs: new Set(collection.tabIds.filter((tabId) => tabIds.has(tabId))).size,
    }));
  const brief = readWorkspaceBrief(workspace.brief);
  return {
    workspaceId: workspace.id,
    name: workspace.name.trim() || "Untitled workspace",
    ...(brief?.description ? { description: brief.description } : {}),
    ...(brief?.focus ? { focus: brief.focus } : {}),
    tabs: workspace.tabs.length,
    collections: own.length,
    recentChanges: Math.max(0, input.recentChanges ?? 0),
    importantCollections: own
      .filter((collection) => collection.tabs > 0)
      .sort((a, b) => b.tabs - a.tabs || compareText(a.name, b.name) || compareText(a.id, b.id))
      .slice(0, IMPORTANT_COLLECTIONS),
  };
}

/** Locale-independent ordering, so a brief reads the same on every machine. */
export function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "12 tabs · 3 collections · 4 recent changes" — the last part only when there are any. */
export function briefCountsLine(view: Pick<WorkspaceBriefView, "tabs" | "collections" | "recentChanges">): string {
  return [
    plural(view.tabs, "tab", "tabs"),
    plural(view.collections, "collection", "collections"),
    ...(view.recentChanges > 0 ? [plural(view.recentChanges, "recent change", "recent changes")] : []),
  ].join(" · ");
}
