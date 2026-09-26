import type { AgentContextLimits } from "./limits";
import type { DependencyType } from "@/lib/dependencies/types";

/**
 * The Hubble Context Bridge's domain.
 *
 * ## The one sentence this module exists to enforce
 *
 * > Context is what an agent is allowed to **know**. Permission is what an
 * > agent is allowed to **do**. Project scope is **where** it may act.
 *
 * Nothing in this file grants anything. There is no capability here, no
 * permission scope, no path an adapter may reach, no handle to a store, and
 * no field an adapter could interpret as authorization. A snapshot that says
 * `{ sourceType: "project", root: "C:/work/api" }` tells an agent that a
 * directory by that name exists and is associated with this workspace. It
 * does not let the agent open it — that requires `read_project` in a grant
 * plus a registered `AgentProject`, both of which live in the control plane
 * and neither of which this module can produce.
 *
 * `security.test.ts` asserts the separation mechanically, from both sides.
 *
 * ## Where this sits
 *
 * `lib/agents/context/` is a **sibling** of `control/` and `connectors/`,
 * for exactly the reason Phase B made control a sibling of connectors: the
 * bridge reads Hubble's domain (workspaces, tabs, collections,
 * dependencies, the graph, agent runs), and the control plane must not. The
 * dependency runs one way — context imports the control plane's attachment
 * contract, and the control plane imports nothing from here.
 *
 *     lib/workspace, lib/tabs, lib/collections, lib/dependencies, lib/graph
 *                                   |
 *                                   v
 *                          lib/agents/context   ──►  AgentContextAttachment
 *                                                            |
 *                                                            v
 *                                                   lib/agents/control
 *
 * ## Untrusted by construction
 *
 * Every string reachable from an item — a workspace name, a tab title, a
 * URL, a collection name, a note — is content the user (or a web page they
 * visited) authored. It is **data**. It is never merged into a system
 * prompt, never used to build provider configuration, and never interpreted
 * as an instruction by anything in Hubble. See `sanitize.ts` for what is
 * removed and, just as importantly, what is deliberately left alone.
 */

/**
 * The kinds of Hubble knowledge the bridge can express.
 *
 * A closed union, and every member is implemented — there is no entry here
 * for a source that cannot yet be resolved, bounded and tested, because an
 * enum member is the easiest way to make a UI offer something that silently
 * returns nothing.
 */
export type AgentContextSourceType =
  | "workspace"
  | "tab"
  | "collection"
  | "relationship"
  | "graph"
  | "project"
  | "agent_activity";

export const AGENT_CONTEXT_SOURCE_TYPES: readonly AgentContextSourceType[] = [
  "workspace",
  "tab",
  "collection",
  "relationship",
  "graph",
  "project",
  "agent_activity",
] as const;

export function isAgentContextSourceType(value: unknown): value is AgentContextSourceType {
  return (
    typeof value === "string" &&
    (AGENT_CONTEXT_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ *
 * Scope
 * ------------------------------------------------------------------ */

/**
 * The boundary a single context request may reach inside.
 *
 * ## Why an id is never enough
 *
 * Hubble partitions local data by account through a storage key prefix
 * (see `lib/storage/namespace.ts`). That partition is applied when data is
 * *loaded*, which means a resolver handed a workspace id has no way to tell
 * whose workspace it is — the id is just a string, and two accounts in the
 * same browser can hold ids that were minted the same way.
 *
 * So the scope carries the owner, the world carries the owner, and the
 * resolver refuses when they disagree. That turns "the caller loaded the
 * right account's data" from an assumption into a checked precondition, and
 * it is the reason there is no `resolveContext(workspaceId)` overload.
 *
 * `ownerId` is `null` when signed out, which is a real account boundary of
 * its own: signed-out content must not resolve into a signed-in session.
 */
export type AgentContextScope = {
  ownerId: string | null;
  /**
   * The workspaces this request may reach. Never empty, and there is no
   * value meaning "all of them" — a caller that wants several names them.
   */
  workspaceIds: readonly string[];
  /** The projects this request may reach. Empty is normal. */
  projectIds: readonly string[];
};

export function isWellFormedScope(scope: AgentContextScope): boolean {
  if (scope.ownerId !== null && typeof scope.ownerId !== "string") return false;
  if (!Array.isArray(scope.workspaceIds) || scope.workspaceIds.length === 0) return false;
  if (!Array.isArray(scope.projectIds)) return false;
  if (!scope.workspaceIds.every((id) => typeof id === "string" && id.length > 0)) return false;
  if (!scope.projectIds.every((id) => typeof id === "string" && id.length > 0)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

type ItemBase = {
  /** Hubble's own id for the thing. Stable, and the key a refresh re-resolves by. */
  sourceId: string;
  /** What to call it. Sanitized and bounded; never a raw title. */
  label: string;
};

export type WorkspaceContextItem = ItemBase & {
  sourceType: "workspace";
  tabCount: number;
  collectionCount: number;
  createdAt?: number;
  updatedAt?: number;
};

export type TabContextItem = ItemBase & {
  sourceType: "tab";
  workspaceId: string;
  /** Redacted. See `redactUrl` — absent when the stored URL would not parse. */
  url?: string;
  domain?: string;
  /** True when redaction removed something. Recorded so the snapshot is explainable. */
  urlRedacted?: boolean;
  /** Collections in scope that hold this tab. */
  collectionIds: readonly string[];
  /** Only ever present when the request explicitly asked for notes. */
  note?: string;
  createdAt?: number;
  lastAccessedAt?: number;
};

export type CollectionContextItem = ItemBase & {
  sourceType: "collection";
  workspaceId: string;
  /** Members, bounded by `maxCollectionMembers`. */
  tabIds: readonly string[];
  /** The real size, so a caller can see that the list above was cut. */
  memberCount: number;
  membersTruncated: boolean;
};

/**
 * One directional dependency between two tabs.
 *
 * Mirrors `TabDependency` rather than inventing a second spelling of
 * "related". `relation` is fixed at `"depends-on"` because that is what the
 * canonical type means; the symmetric `ManualConnection` is a graph edge and
 * arrives through the `graph` source instead.
 */
export type RelationshipContextItem = ItemBase & {
  sourceType: "relationship";
  relation: "depends-on";
  fromTabId: string;
  toTabId: string;
  kind?: DependencyType;
};

export type GraphContextNode = {
  tabId: string;
  label: string;
  domain?: string;
  /** Hops from the centre. 0 is the centre itself. */
  distance: number;
};

export type GraphContextEdge = {
  fromTabId: string;
  toTabId: string;
  /** Why Hubble drew this edge — `domain`, `workspace`, `manual`, and so on. */
  reasons: readonly string[];
};

export type GraphContextItem = ItemBase & {
  sourceType: "graph";
  centerTabId: string;
  depth: number;
  nodes: readonly GraphContextNode[];
  edges: readonly GraphContextEdge[];
  nodesTruncated: boolean;
  edgesTruncated: boolean;
};

/**
 * A local project, as metadata only.
 *
 * `root` is the single most sensitive string the bridge can emit, and it is
 * governed by two independent rules:
 *
 *   - it is present only when the caller says local execution is permitted
 *     here (see `ResolveOptions.localRuntimeAllowed`, which defaults to
 *     `false`);
 *   - it is a **name**, not a grant. An agent told the root exists cannot
 *     read it. That takes `read_project` plus a registered project in the
 *     control plane, and neither can be produced from this record.
 *
 * There is no field for file contents, a file list, a repository state or a
 * directory listing, and adding one would be a different phase with a
 * different security argument.
 */
export type ProjectContextItem = ItemBase & {
  sourceType: "project";
  projectId: string;
  root?: string;
  /** Absent because the runtime is hosted, rather than because there is no root. */
  rootWithheld?: boolean;
  /** How many providers are authorized. A count, never the list. */
  authorizedProviderCount: number;
};

export type AgentActivityContextItem = ItemBase & {
  sourceType: "agent_activity";
  runId: string;
  workspaceId: string;
  agentName: string;
  /** The provider key, opaque here exactly as it is in the observation domain. */
  provider: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
};

export type AgentContextItem =
  | WorkspaceContextItem
  | TabContextItem
  | CollectionContextItem
  | RelationshipContextItem
  | GraphContextItem
  | ProjectContextItem
  | AgentActivityContextItem;

/* ------------------------------------------------------------------ *
 * Omissions
 * ------------------------------------------------------------------ */

/**
 * Why something the caller asked for is not in the snapshot.
 *
 * Every drop produces one of these. A resolver that silently returned less
 * than it was asked for would make a snapshot unfalsifiable — a caller
 * could not tell "this workspace has three tabs" from "this workspace has
 * four hundred and you got three".
 */
export type AgentContextOmissionReason =
  /** No such entity in the world at capture time. */
  | "not-found"
  /** The entity exists but lies outside the request's scope. */
  | "out-of-scope"
  /** An id was supplied for a source type the request did not list. */
  | "source-not-requested"
  /** A per-source-type cap. */
  | "limit-workspaces"
  | "limit-tabs"
  | "limit-collections"
  | "limit-collection-members"
  | "limit-relationships"
  | "limit-graph-nodes"
  | "limit-graph-edges"
  | "limit-projects"
  | "limit-agent-activity"
  /** The overall item cap. */
  | "limit-items"
  /** The overall character budget. */
  | "limit-characters"
  /** Local-only data, and this environment may not resolve it. */
  | "hosted-runtime";

export type AgentContextOmission = {
  sourceType: AgentContextSourceType;
  reason: AgentContextOmissionReason;
  /** How many entities this omission accounts for. */
  count: number;
  /**
   * Which ones, bounded.
   *
   * Bounded rather than complete because an omission list for "3,900 tabs
   * over the cap" would itself be the unbounded payload the cap exists to
   * prevent. `count` is always exact; `sourceIds` is a sample.
   */
  sourceIds: readonly string[];
};

/** How many ids an omission carries before it stops listing them. */
export const MAX_OMISSION_SOURCE_IDS = 20;

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

export type GraphContextRequest = {
  /** Tabs to expand outward from. Each produces one `GraphContextItem`. */
  centerTabIds: readonly string[];
  /** Hops. Clamped to `maxGraphDepth`; 0 yields the centre alone. */
  depth: number;
};

export type AgentActivityContextRequest = {
  /**
   * How many runs, newest first. Clamped to `maxAgentActivity`.
   *
   * Absent means the limit. There is no "all".
   */
  limit?: number;
};

/**
 * An explicit ask.
 *
 * ## What is deliberately impossible to express
 *
 * There is no `includeEverything`, no `all: true`, no wildcard id and no
 * "the current workspace" shorthand. Every source is named, and every
 * source's ids are named, because the alternative is a request whose meaning
 * depends on how much data the user happens to have.
 *
 * A caller that wants "this whole workspace" names the workspace in
 * `workspaceIds`, asks for the `tab` source, and accepts the tab cap — which
 * is the bounded version of the same intent, and says so in the snapshot
 * when it does not fit.
 */
export type AgentContextRequest = {
  scope: AgentContextScope;
  /** Which source types to resolve. Never empty. */
  sources: readonly AgentContextSourceType[];
  workspaceIds?: readonly string[];
  tabIds?: readonly string[];
  collectionIds?: readonly string[];
  projectIds?: readonly string[];
  graph?: GraphContextRequest;
  agentActivity?: AgentActivityContextRequest;
  /**
   * Whether to include the user's freeform per-tab notes.
   *
   * Off by default, and off is not merely a conservative default — a note is
   * the one field in a tab where a person has typed prose of their own, and
   * it is therefore the likeliest place for something they would not choose
   * to send anywhere. Including it is a decision the caller makes explicitly.
   */
  includeNotes?: boolean;
  limits?: Partial<AgentContextLimits>;
};

export function isWellFormedRequest(request: AgentContextRequest): boolean {
  if (!request || typeof request !== "object") return false;
  if (!isWellFormedScope(request.scope)) return false;
  if (!Array.isArray(request.sources) || request.sources.length === 0) return false;
  if (!request.sources.every(isAgentContextSourceType)) return false;

  for (const key of ["workspaceIds", "tabIds", "collectionIds", "projectIds"] as const) {
    const value = request[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return false;
    if (!value.every((id) => typeof id === "string" && id.length > 0)) return false;
  }

  if (request.graph !== undefined) {
    if (!Array.isArray(request.graph.centerTabIds)) return false;
    if (!request.graph.centerTabIds.every((id) => typeof id === "string" && id.length > 0)) {
      return false;
    }
    if (typeof request.graph.depth !== "number" || !Number.isFinite(request.graph.depth)) {
      return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Snapshot
 * ------------------------------------------------------------------ */

/**
 * What was actually resolved, frozen at one moment.
 *
 * ## Why a snapshot rather than a live view
 *
 * A run that was told "this workspace holds A, B and C" must keep being
 * told that for the rest of the turn, even if the user adds D while the
 * agent is thinking. A live view would make a session's behaviour depend on
 * unrelated UI activity, which is both unreasonable to debug and a way for
 * data to reach a provider that the user never attached.
 *
 * So a snapshot is minted once, deep-frozen, and never mutated. Getting
 * newer data is `refreshSnapshot`, which mints a **second** snapshot with a
 * new id and leaves the first exactly as it was.
 *
 * ## Staleness is stated, not hidden
 *
 * `capturedAt` is on every snapshot, and every item keeps its canonical
 * `sourceId`. Together they answer "this entity existed, under this name, at
 * this time" — which is the honest claim. If an entity has since been
 * deleted, a refresh reports it as `not-found` rather than quietly
 * substituting something else.
 */
export type AgentContextSnapshot = {
  id: string;
  capturedAt: number;
  scope: AgentContextScope;
  /** The limits this resolution actually ran under, after clamping. */
  limits: AgentContextLimits;
  /** What the caller asked for, for auditability. */
  requestedSources: readonly AgentContextSourceType[];
  items: readonly AgentContextItem[];
  omissions: readonly AgentContextOmission[];
  /** Characters counted against `limits.maxCharacters`. */
  characterCount: number;
  /** True when anything at all was dropped. Equivalent to a non-empty `omissions`. */
  truncated: boolean;
  /**
   * The snapshot this one replaced, when it came from a refresh.
   *
   * A chain rather than a mutation, so "what did the agent know at each
   * point in this session" is answerable after the fact.
   */
  previousSnapshotId?: string;
};

/** An empty snapshot. The honest result of a request that resolved nothing. */
export function isEmptySnapshot(snapshot: AgentContextSnapshot): boolean {
  return snapshot.items.length === 0;
}

/** Every item of one source type, in snapshot order. */
export function itemsOfType<T extends AgentContextSourceType>(
  snapshot: AgentContextSnapshot,
  sourceType: T
): Extract<AgentContextItem, { sourceType: T }>[] {
  return snapshot.items.filter(
    (item): item is Extract<AgentContextItem, { sourceType: T }> => item.sourceType === sourceType
  );
}
