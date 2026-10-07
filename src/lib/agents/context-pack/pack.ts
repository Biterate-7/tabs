import { itemsOfType } from "@/lib/agents/context/types";
import { resolveContext } from "@/lib/agents/context/resolve";
import { sanitizeText } from "@/lib/agents/context/sanitize";
import { selectionToRequest } from "@/lib/agents/command-centre/context-selection";
import {
  scopeOf,
  toContextSelection,
  withinWorkspace,
} from "@/lib/agents/command-centre/working-context";
import { describeChange } from "@/lib/agents/command-centre/workspace-activity";
import { readHandoffInstruction } from "@/lib/agents/handoff/handoff";
import { compareText, describeWorkspaceBrief } from "@/lib/workspace/brief";
import { scrubSecretShapes } from "@/lib/secret-shapes";
import { isSecretLikePath } from "@/lib/agents/project/secrets";
import { readProjectCapabilities } from "@/lib/agents/project/capabilities";
import type { ProjectCapability } from "@/lib/agents/project/capabilities";
import type { ProjectDescriptor } from "@/lib/agents/project/describe";
import type { ProjectAccessState, ProjectTypeId } from "@/lib/agents/project/inspection";
import type { AgentContextWorld } from "@/lib/agents/context/world";
import type { ContextResolutionFailure } from "@/lib/agents/context/resolve";
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity";
import type { ContextScope, WorkingContext } from "@/lib/agents/command-centre/working-context";
import type { HandoffPreviousResult } from "@/lib/agents/handoff/handoff";
import { redactUrl } from "@/lib/agents/context/sanitize";
import { selectedSources } from "@/lib/resources/context";
import type { ResourceKind, ResourceStatus } from "@/lib/resources/types";

/**
 * The Context Pack (Hubble 1.5): the one canonical answer to "what does
 * Hubble give this agent?".
 *
 *     ContextPack
 *     ├── workspace        name, the user's brief, how big it is
 *     ├── scope            whole workspace / one tab / tabs / a collection / custom
 *     ├── collections      the ones selected, by name
 *     ├── tabs             the ones selected — titles and redacted addresses
 *     ├── relationships    between the selected tabs
 *     ├── sources          the project sources in scope: kind, whether Hubble could read them (2.0)
 *     ├── project          the workspace's project: name, kind, Git, what the agent may do (1.6)
 *     ├── files            project files the work touched, and whether each changed since
 *     ├── recentChanges    agent changes applied in the workspace
 *     ├── previousResult   what an earlier session did (a handoff)
 *     └── instruction      the person's own words
 *
 * ## Built in one place, from what already exists
 *
 * `buildContextPack` is the only constructor. The selection is the Command
 * Centre's `WorkingContext`; stale references are dropped by its
 * `withinWorkspace`; the tabs, collections and relationships are resolved by
 * the Phase E bridge (`resolveContext`), so every title is sanitized, every
 * address redacted, every limit applied and every account boundary checked
 * by the code that already does that. The previous result is the handoff's
 * own, the instruction is scrubbed by the handoff's own reader. Nothing here
 * re-implements any of it.
 *
 * ## What can never be in a pack
 *
 * There is no field for a credential, a token, a header, a cookie, a runtime
 * address, a protocol payload, a transcript or an agent's reasoning — and
 * every string that does go in came through a sanitizer first. The pack is a
 * description of the user's own resources, nothing more.
 *
 * ## Deterministic
 *
 * No clock, no randomness, no input order: collections, tabs, relationships,
 * files and changes are sorted by locale-independent rules, duplicates are
 * removed by a fixed rule, and `fingerprint` hashes the result. The same
 * workspace and the same selection always make the same pack — which is what
 * lets Hubble tell that a session's context has changed since it was sent.
 *
 * The fingerprint covers the context, not the instruction: the instruction is
 * what the person types each turn, and the context is what it is about.
 */

export const CONTEXT_PACK_VERSION = 1;

export const CONTEXT_PACK_LIMITS = {
  /** Selected tabs and collections: the bounds a session's focus is held to. */
  tabs: 50,
  collections: 20,
  relationships: 20,
  files: 20,
  recentChanges: 5,
  /** Project sources described to an agent (Hubble 2.0). Their text is read on request, never sent here. */
  sources: 50,
  /** A project-relative path, as the activity timeline carries it. */
  path: 300,
} as const;

export type ContextPackWorkspace = {
  id: string;
  name: string;
  /** The user's brief: what the workspace is for. */
  description?: string;
  /** The user's brief: what is being worked on now. */
  focus?: string;
  /** How much the workspace holds — what a whole-workspace session can read on request. */
  tabs: number;
  collections: number;
  /** Project sources (Hubble 2.0). Absent: none. */
  sources?: number;
};

export type ContextPackCollection = { id: string; name: string; tabs: number };
export type ContextPackTab = { id: string; title: string; domain?: string; url?: string };
export type ContextPackRelationship = { id: string; label: string };
/**
 * A project file the work touched (project-relative). `state`/`hash` are what
 * the runtime found when it last looked (Hubble 1.6): a file changed outside
 * the session changes the hash, and so the pack's fingerprint.
 */
export type ContextPackFile = {
  path: string;
  change: "created" | "updated";
  state?: "present" | "missing";
  hash?: string;
  /** Changed outside the session since its agent last wrote it (Hubble 1.6). */
  outside?: true;
};

/**
 * The workspace's project, as an agent is told it (Hubble 1.6). Never a path:
 * a local project's folder never leaves this device, and a remote agent is
 * never sent one.
 */
export type ContextPackProject = {
  id: string;
  name: string;
  location: "local" | "remote";
  state?: ProjectAccessState;
  type?: ProjectTypeId;
  repository?: { branch?: string; head?: string; detached?: boolean };
  /** What the agent may do there — every one enforced by the runtime. */
  capabilities: readonly ProjectCapability[];
};
export type ContextPackChange = { id: string; text: string; at: number };

/**
 * A project source as an agent is told about it (Hubble 2.0): what it is and
 * whether its text can be read — never the text itself, which the session
 * reads on request (`read_source`) from the content its selection carries.
 */
export type ContextPackSource = {
  id: string;
  title: string;
  kind: ResourceKind;
  status: ResourceStatus;
  domain?: string;
  url?: string;
  pages?: number;
  /** The page's own description, bounded — page-authored, and framed as such where it is shown. */
  summary?: string;
  /** Why there is no text, in Hubble's words. */
  note?: string;
};

export type ContextPack = {
  version: typeof CONTEXT_PACK_VERSION;
  workspace: ContextPackWorkspace;
  /** Derived from what is selected, never stored: see `scopeOf`. */
  scope: ContextScope;
  collections: readonly ContextPackCollection[];
  tabs: readonly ContextPackTab[];
  relationships: readonly ContextPackRelationship[];
  /** The project sources in this selection (Hubble 2.0): the whole project's, or the selected ones. */
  sources: readonly ContextPackSource[];
  /** The workspace's project (Hubble 1.6). Absent when none is attached. */
  project?: ContextPackProject;
  files: readonly ContextPackFile[];
  recentChanges: readonly ContextPackChange[];
  previousResult?: HandoffPreviousResult;
  instruction?: string;
  /** What was asked for and is not here — said, never silently dropped. */
  omitted: {
    /** Selected, but no longer in this workspace (deleted, moved, another workspace's). */
    missing: number;
    /** Tabs left out because another selected tab has the same address. */
    duplicates: number;
    /** Left out to stay within the bounds. */
    truncated: number;
    /** Project files left out because they may hold secrets (Hubble 1.6). Absent when none. */
    sensitive?: number;
  };
  /** 16 hex characters over everything above except the instruction. */
  fingerprint: string;
};

export type ContextPackInput = {
  /** The account's loaded data — the Phase E resolver's world. */
  world: AgentContextWorld;
  /** What the person selected. The whole workspace is a selection too. */
  selection: WorkingContext;
  /** Applied agent changes, from anywhere; only this workspace's, applied and not undone, are kept. */
  changes?: readonly AppliedWorkspaceChange[];
  /** A session whose own changes are left out of `recentChanges` — the agent made them, so it knows. */
  excludeChangesOf?: string;
  /** Project files the work touched, project-relative. */
  files?: readonly ContextPackFile[];
  /** The workspace's project, as the runtime found it (Hubble 1.6). */
  project?: ProjectDescriptor;
  previousResult?: HandoffPreviousResult;
  instruction?: string;
};

export type ContextPackFailure = "workspace-missing" | ContextResolutionFailure;

export type ContextPackResult = { ok: true; pack: ContextPack } | { ok: false; reason: ContextPackFailure };

/**
 * Every string a pack holds, scrubbed of anything shaped like a credential —
 * a title or a name can carry a pasted key as easily as a brief can. Phase E
 * already sanitized and redacted it; this is the second, shared net.
 */
function clean(text: string): string {
  return scrubSecretShapes(text);
}

/** The id a resolution inside a pack runs under. Never surfaced: the pack's own id is its fingerprint. */
const RESOLUTION_ID = "context-pack";

function byName<T extends { name: string; id: string }>(a: T, b: T): number {
  return compareText(a.name, b.name) || compareText(a.id, b.id);
}

function byTitle(a: ContextPackTab, b: ContextPackTab): number {
  return compareText(a.title, b.title) || compareText(a.url ?? "", b.url ?? "") || compareText(a.id, b.id);
}

/** A project-relative path that stays inside its project, or `undefined`. */
export function readPackPath(value: unknown): string | undefined {
  const path = sanitizeText(value, CONTEXT_PACK_LIMITS.path);
  if (path && clean(path) !== path) return undefined;
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
  if (normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function normalizeFiles(
  files: readonly ContextPackFile[] | undefined,
  project: ProjectDescriptor | undefined
): { files: ContextPackFile[]; truncated: number; sensitive: number } {
  const byPath = new Map<string, ContextPackFile>();
  let sensitive = 0;
  const states = new Map((project?.files ?? []).map((file) => [file.path, file]));
  for (const file of files ?? []) {
    const path = readPackPath(file.path);
    if (!path) continue;
    // Never named to an agent, let alone read: said in `omitted` instead.
    if (isSecretLikePath(path)) {
      sensitive += 1;
      continue;
    }
    const change = file.change === "created" ? "created" : "updated";
    // Created wins over updated: a file this work made is a file it made, however often it was then edited.
    const existing = byPath.get(path);
    const outside = file.outside === true || existing?.outside === true;
    if (!existing || (existing.change === "updated" && change === "created") || outside !== Boolean(existing.outside)) {
      byPath.set(path, { path, change: existing?.change === "created" ? "created" : change, ...(outside ? { outside: true as const } : {}) });
    }
  }
  const sorted = [...byPath.values()].sort((a, b) => compareText(a.path, b.path));
  // How each file is now, from the runtime's last look (Hubble 1.6).
  const withState = sorted.map((file): ContextPackFile => {
    const now = states.get(file.path);
    if (now?.state === "present" && now.hash) return { ...file, state: "present", hash: now.hash };
    if (now?.state === "missing") return { ...file, state: "missing" };
    return file;
  });
  return {
    files: withState.slice(0, CONTEXT_PACK_LIMITS.files),
    truncated: Math.max(0, sorted.length - CONTEXT_PACK_LIMITS.files),
    sensitive,
  };
}

function recentChangesOf(input: ContextPackInput, workspaceId: string): ContextPackChange[] {
  return (input.changes ?? [])
    .filter(
      (change) =>
        change.workspaceId === workspaceId &&
        change.ok &&
        !change.undone &&
        change.steps.length > 0 &&
        (!input.excludeChangesOf || change.sessionId !== input.excludeChangesOf)
    )
    .sort((a, b) => b.at - a.at || compareText(a.id, b.id))
    .slice(0, CONTEXT_PACK_LIMITS.recentChanges)
    .map((change) => ({ id: change.id, text: clean(describeChange(change)), at: change.at }));
}

/**
 * The pack for one selection. `workspace-missing` when the selection's
 * workspace no longer exists; the resolver's own failure when it refused
 * (a world loaded for a different account).
 */
export function buildContextPack(input: ContextPackInput): ContextPackResult {
  const { world } = input;
  const workspace = world.workspaces.find((entry) => entry.id === input.selection.workspaceId);
  if (!workspace) return { ok: false, reason: "workspace-missing" };

  const { context, dropped } = withinWorkspace(input.selection, world);
  const brief = describeWorkspaceBrief({ workspace, collections: world.collections });

  let collections: ContextPackCollection[] = [];
  let tabs: ContextPackTab[] = [];
  let relationships: ContextPackRelationship[] = [];
  let missing = dropped;
  let truncated = 0;
  let duplicates = 0;

  const selection = toContextSelection(context);
  if (selection) {
    // The Phase E resolver, exactly as a session's context has always been
    // resolved: scoped to this workspace and owner, nothing else reachable.
    const request = selectionToRequest(selection, {
      ownerId: world.ownerId,
      workspaceIds: [workspace.id],
      projectIds: [],
    });
    if (!request) return { ok: false, reason: "invalid-request" };
    const resolution = resolveContext(request, world, { now: () => 0, createSnapshotId: () => RESOLUTION_ID });
    if (!resolution.ok) return resolution;
    const { snapshot } = resolution;

    for (const omission of snapshot.omissions) {
      if (omission.reason === "not-found" || omission.reason === "out-of-scope") missing += omission.count;
      else if (omission.reason.startsWith("limit-")) truncated += omission.count;
    }

    collections = itemsOfType(snapshot, "collection")
      .map((item) => ({ id: item.sourceId, name: clean(item.label), tabs: item.memberCount }))
      .sort(byName);

    // Same address twice is one resource: the first in sorted order stays.
    const sorted = itemsOfType(snapshot, "tab")
      .map((item): ContextPackTab => ({
        id: item.sourceId,
        title: clean(item.label),
        ...(item.domain ? { domain: item.domain } : {}),
        ...(item.url ? { url: clean(item.url) } : {}),
      }))
      .sort(byTitle);
    const seen = new Set<string>();
    for (const tab of sorted) {
      const key = tab.url ?? `id:${tab.id}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      tabs.push(tab);
    }
    if (tabs.length > CONTEXT_PACK_LIMITS.tabs) {
      truncated += tabs.length - CONTEXT_PACK_LIMITS.tabs;
      tabs = tabs.slice(0, CONTEXT_PACK_LIMITS.tabs);
    }
    if (collections.length > CONTEXT_PACK_LIMITS.collections) {
      truncated += collections.length - CONTEXT_PACK_LIMITS.collections;
      collections = collections.slice(0, CONTEXT_PACK_LIMITS.collections);
    }

    const kept = new Set(tabs.map((tab) => tab.id));
    relationships = itemsOfType(snapshot, "relationship")
      .filter((item) => kept.has(item.fromTabId) && kept.has(item.toTabId))
      .map((item) => ({ id: item.sourceId, label: clean(item.label) }))
      .sort((a, b) => compareText(a.label, b.label) || compareText(a.id, b.id))
      .slice(0, CONTEXT_PACK_LIMITS.relationships);
  }

  // Project sources (Hubble 2.0): the selection decides which, exactly as it decides which tabs.
  const whole = context.tabIds.length === 0 && context.collectionIds.length === 0;
  const allSources = selectedSources(
    workspace.tabs,
    whole ? undefined : { tabIds: context.tabIds, collectionIds: context.collectionIds },
    world.collections.filter((collection) => collection.workspaceId === workspace.id)
  )
    .map((tab): ContextPackSource => {
      const resource = tab.resource!;
      const redacted = redactUrl(tab.url);
      const summary = resource.meta?.description ? sanitizeText(resource.meta.description, 160) : undefined;
      const pages = resource.content?.pages ?? resource.meta?.pageCount;
      return {
        id: tab.id,
        title: clean(sanitizeText(tab.title) ?? redacted?.url ?? tab.domain),
        kind: resource.kind,
        status: resource.status,
        ...(tab.domain ? { domain: tab.domain } : {}),
        ...(redacted ? { url: clean(redacted.url) } : {}),
        ...(pages ? { pages } : {}),
        ...(summary ? { summary: clean(summary) } : {}),
        ...(resource.status !== "ready" && resource.error ? { note: clean(resource.error.message) } : {}),
      };
    })
    .sort((a, b) => compareText(a.title, b.title) || compareText(a.id, b.id));
  truncated += Math.max(0, allSources.length - CONTEXT_PACK_LIMITS.sources);
  const sources = allSources.slice(0, CONTEXT_PACK_LIMITS.sources);
  const sourceCount = workspace.tabs.filter((tab) => tab.resource).length;

  const files = normalizeFiles(input.files, input.project);
  truncated += files.truncated;
  const project = packProject(input.project);
  const instruction = readHandoffInstruction(input.instruction);

  const body: Omit<ContextPack, "fingerprint"> = {
    version: CONTEXT_PACK_VERSION,
    workspace: {
      id: workspace.id,
      name: clean(sanitizeText(brief.name) ?? "Untitled workspace"),
      ...(brief.description ? { description: brief.description } : {}),
      ...(brief.focus ? { focus: brief.focus } : {}),
      tabs: brief.tabs,
      collections: brief.collections,
      ...(sourceCount > 0 ? { sources: sourceCount } : {}),
    },
    scope: scopeOf({ workspaceId: workspace.id, tabIds: tabs.map((tab) => tab.id), collectionIds: collections.map((entry) => entry.id) }),
    collections,
    tabs,
    relationships,
    sources,
    ...(project ? { project } : {}),
    files: files.files,
    recentChanges: recentChangesOf(input, workspace.id),
    ...(input.previousResult ? { previousResult: input.previousResult } : {}),
    ...(instruction ? { instruction } : {}),
    omitted: { missing, duplicates, truncated, ...(files.sensitive > 0 ? { sensitive: files.sensitive } : {}) },
  };
  return { ok: true, pack: { ...body, fingerprint: contextPackFingerprint(body) } };
}

/** The pack's project section: the descriptor, minus file states (those ride on `files`). */
function packProject(descriptor: ProjectDescriptor | undefined): ContextPackProject | undefined {
  if (!descriptor) return undefined;
  const repository = descriptor.repository
    ? {
        ...(descriptor.repository.branch ? { branch: descriptor.repository.branch } : {}),
        ...(descriptor.repository.head ? { head: descriptor.repository.head } : {}),
        ...(descriptor.repository.detached ? { detached: true } : {}),
      }
    : undefined;
  return {
    id: descriptor.id,
    name: clean(sanitizeText(descriptor.name, 120) ?? "Untitled project"),
    location: descriptor.location === "remote" ? "remote" : "local",
    ...(descriptor.state ? { state: descriptor.state } : {}),
    ...(descriptor.type ? { type: descriptor.type } : {}),
    ...(repository ? { repository } : {}),
    capabilities: readProjectCapabilities(descriptor.capabilities),
  };
}

/* ------------------------------------------------------------------ *
 * Fingerprint
 * ------------------------------------------------------------------ */

/** A key-sorted serialization, so the same value always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const CONTEXT_PACK_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

/** The pack's fingerprint: its context, without the instruction. Equality, not secrecy. */
export function contextPackFingerprint(pack: Omit<ContextPack, "fingerprint">): string {
  const context: Record<string, unknown> = { ...pack };
  delete context.instruction;
  delete context.fingerprint;
  const text = stable(context);
  return fnv(text, 0x811c9dc5) + fnv(text, 0x9e3779b9);
}

/** The id a pack is attached under: what the runtime reports back as the session's context. */
export function contextPackId(pack: Pick<ContextPack, "fingerprint">): string {
  return `pack-${pack.fingerprint}`;
}

export const CONTEXT_PACK_ID_PATTERN = /^pack-[0-9a-f]{16}$/;

export function isContextPackId(value: unknown): value is string {
  return typeof value === "string" && CONTEXT_PACK_ID_PATTERN.test(value);
}
