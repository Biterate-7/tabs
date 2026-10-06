import { readWorkspaceBrief } from "@/lib/workspace/brief";
import type { Collection } from "@/lib/collections/types";
import type { DependencyType, TabDependency } from "@/lib/dependencies/types";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace } from "@/lib/workspace/types";
import { readTabResource } from "@/lib/resources/read";
import { RESOURCE_KINDS } from "@/lib/resources/types";
import type { ResourceKind, TabResource } from "@/lib/resources/types";

/**
 * The one workspace an agent session can see, as the runtime holds it
 * (Phase J.3).
 *
 * ## Why the webview sends it at all
 *
 * Hubble is local-first: a workspace lives in the app's own storage, not in
 * any server the runtime could ask — and in the desktop app there is no server
 * at all. So when a session starts, the Command Centre hands the runtime a
 * bounded copy of exactly the workspace the session was started from, and
 * keeps it current. The agent never sees this object; it *queries* it through
 * Hubble's MCP server, one bounded answer at a time. Nothing here is a prompt.
 *
 * ## Built on one side, read strictly on the other
 *
 * `buildSessionContextSnapshot` (webview) copies an allowlist of fields and
 * applies the bounds. `readSessionContextSnapshot` (runtime) does not trust
 * that: it re-reads the wire shape field by field, drops anything unknown,
 * re-applies every bound, and refuses a snapshot of any workspace other than
 * the one the session is bound to. A favicon or logo — data URLs, not context
 * — never crosses.
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
  /**
   * Encoded, so a snapshot always fits the desktop bridge's 1 MB request cap
   * with room to spare. Source content (Hubble 2.0) is dropped before any tab
   * when it does not fit.
   */
  bytes: 800 * 1024,
  /** Sources whose extracted content one session carries (Hubble 2.0), and how much. */
  sources: 50,
  sourceChars: 300_000,
  sourceCharsEach: 100_000,
} as const;

/**
 * What Hubble extracted from one project source, for the session's agent to
 * read through MCP (`read_source`, `search_sources`) — never pasted into a
 * prompt. Only sources in the session's own context selection are carried,
 * chosen and cut to `SNAPSHOT_LIMITS.source*` by `sessionSources`
 * (lib/resources/context.ts); the rest are listed without content and the
 * agent is told so.
 */
export type SessionSource = {
  tabId: string;
  kind: ResourceKind;
  text?: string;
  /** PDF pages; index 0 is page 1. Page numbers survive truncation because pages are only ever dropped from the end. */
  pages?: string[];
  transcript?: { start?: number; text: string }[];
  /** Cut to fit the session's budget — the agent is told the text is partial. */
  truncated?: boolean;
};

export type SessionContextSnapshot = {
  workspace: Workspace;
  collections: Collection[];
  dependencies: TabDependency[];
  /** Tabs were left out to stay within the bounds. The MCP answers say so. */
  truncated: boolean;
  /** Extracted content of the session's selected sources (Hubble 2.0). Absent: none carried. */
  sources?: SessionSource[];
};

/* ------------------------------------------------------------------ *
 * Building (webview)
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
 * A source's description as a session may see it: what it is, whether Hubble
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

function boundedText(value: unknown, budget: { left: number }): { text?: string; cut: boolean } {
  if (typeof value !== "string" || value.length === 0 || budget.left <= 0) return { cut: typeof value === "string" && value.length > 0 };
  const text = value.slice(0, budget.left);
  budget.left -= text.length;
  return { text, cut: text.length < value.length };
}

/** Source content, re-read and re-bounded: only sources of tabs in this snapshot, within every limit. */
function copySources(raw: unknown, sourceTabIds: ReadonlySet<string>): SessionSource[] {
  if (!Array.isArray(raw)) return [];
  const total = { left: SNAPSHOT_LIMITS.sourceChars };
  const out: SessionSource[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= SNAPSHOT_LIMITS.sources || total.left <= 0) break;
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const tabId = text(source.tabId, 200);
    if (!tabId || !sourceTabIds.has(tabId) || seen.has(tabId)) continue;
    if (!RESOURCE_KINDS.includes(source.kind as ResourceKind)) continue;
    seen.add(tabId);
    const each = { left: Math.min(SNAPSHOT_LIMITS.sourceCharsEach, total.left) };
    const before = each.left;
    const copy: SessionSource = { tabId, kind: source.kind as ResourceKind };
    let cut = source.truncated === true;
    const body = boundedText(source.text, each);
    if (body.text) copy.text = body.text;
    cut ||= body.cut;
    if (Array.isArray(source.pages)) {
      const pages: string[] = [];
      for (const page of source.pages) {
        if (typeof page !== "string") break;
        if (each.left <= 0) {
          cut = true;
          break;
        }
        const piece = boundedText(page, each);
        pages.push(piece.text ?? "");
        cut ||= piece.cut;
      }
      if (pages.length > 0) copy.pages = pages;
    }
    if (Array.isArray(source.transcript)) {
      const lines: { start?: number; text: string }[] = [];
      for (const line of source.transcript) {
        if (!line || typeof line !== "object") continue;
        if (each.left <= 0) {
          cut = true;
          break;
        }
        const piece = boundedText((line as { text?: unknown }).text, each);
        if (!piece.text) continue;
        const start = time((line as { start?: unknown }).start);
        lines.push({ ...(start !== undefined ? { start } : {}), text: piece.text });
        cut ||= piece.cut;
      }
      if (lines.length > 0) copy.transcript = lines;
    }
    if (!copy.text && !copy.pages && !copy.transcript) continue;
    if (cut) copy.truncated = true;
    total.left -= before - each.left;
    out.push(copy);
  }
  return out;
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
  // A relationship to a tab outside this snapshot points outside the session.
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
  // Another workspace's collection is not this session's to see.
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
 * The same function runs on both sides, so the webview never sends what the
 * runtime would drop, and the runtime never keeps what the webview should not
 * have sent. Returns `undefined` for a snapshot of any other workspace.
 */
export function readSessionContextSnapshot(
  raw: unknown,
  expectedWorkspaceId: string
): SessionContextSnapshot | undefined {
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
  const snapshot: SessionContextSnapshot = {
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
  const sources = copySources(source.sources, new Set(tabs.filter((tab) => tab.resource).map((tab) => tab.id)));
  if (sources.length > 0) snapshot.sources = sources;

  // The byte budget, applied last: source content goes first, then tabs from the end, until it fits.
  while (encodedSize(snapshot) > SNAPSHOT_LIMITS.bytes && snapshot.sources && snapshot.sources.length > 0) {
    snapshot.sources = snapshot.sources.slice(0, -1);
    if (snapshot.sources.length === 0) delete snapshot.sources;
  }
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

function encodedSize(snapshot: SessionContextSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).length;
}

/**
 * A short, stable fingerprint of a snapshot's content (Phase J.4).
 *
 * Computed the same way on both sides — the webview over the snapshot it
 * would send, the runtime over the one it holds — so the Command Centre can
 * tell whether a session's context is current without sending anything. Not a
 * security boundary: two FNV-1a passes, for equality, not secrecy.
 */
export function snapshotFingerprint(snapshot: SessionContextSnapshot): string {
  const text = JSON.stringify(snapshot);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * The webview's side: the snapshot of one workspace from the app's own data.
 * `undefined` when the workspace does not exist.
 */
export function buildSessionContextSnapshot(
  world: {
    workspaces: readonly Workspace[];
    collections: readonly Collection[];
    dependencies: readonly TabDependency[];
  },
  workspaceId: string,
  /** The extracted content of the session's selected sources (lib/resources/context.ts `sessionSources`). */
  sources?: readonly SessionSource[]
): SessionContextSnapshot | undefined {
  const workspace = world.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return undefined;
  const tabIds = new Set(workspace.tabs.map((tab) => tab.id));
  return readSessionContextSnapshot(
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
      ...(sources && sources.length > 0 ? { sources } : {}),
    },
    workspaceId
  );
}
