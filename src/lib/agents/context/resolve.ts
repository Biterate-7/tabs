import { buildGraphEdges, buildWorkspaceLookup } from "@/lib/graph/relations";
import { computeLocalDistances } from "@/lib/graph/local-graph";
import { DEFAULT_CONNECTION_FILTERS } from "@/lib/graph/types";
import { clampLimits } from "./limits";
import { countCharacters, MAX_NOTE_LENGTH, redactUrl, sanitizeText } from "./sanitize";
import { indexContextWorld } from "./world";
import { isWellFormedRequest, MAX_OMISSION_SOURCE_IDS } from "./types";
import type { AgentContextLimits } from "./limits";
import type { AgentContextIndex, AgentContextWorld } from "./world";
import type {
  AgentActivityContextItem,
  AgentContextItem,
  AgentContextOmission,
  AgentContextOmissionReason,
  AgentContextRequest,
  AgentContextSnapshot,
  AgentContextSourceType,
  CollectionContextItem,
  GraphContextEdge,
  GraphContextItem,
  GraphContextNode,
  ProjectContextItem,
  RelationshipContextItem,
  TabContextItem,
  WorkspaceContextItem,
} from "./types";
import type { GraphDepth, GraphEdge } from "@/lib/graph/types";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";

/**
 * The Context Bridge's resolver.
 *
 * ## The pipeline
 *
 *     request  ─►  validate  ─►  scope  ─►  resolve  ─►  normalize
 *                                                            │
 *                                          bound  ◄──────────┘
 *                                            │
 *                                            ▼
 *                                        snapshot
 *
 * Every stage can only ever *remove*. There is no path through this module
 * that adds an entity the request did not name, and no path that reaches an
 * entity outside the request's scope — including by following a
 * relationship, which is the interesting case and has its own note below.
 *
 * ## Deny by default, at three separate points
 *
 *   1. A malformed request resolves to nothing at all.
 *   2. A request whose scope names a different account than the world was
 *      loaded under is refused outright, before a single lookup.
 *   3. An entity that is not inside the scope's workspaces (or projects) is
 *      omitted with a reason, however it was reached.
 *
 * ## Why this module reads TabDump's domain and the control plane does not
 *
 * Someone has to know what a workspace is. The design decision Phase B took
 * — and this phase keeps — is that the thing which knows is on TabDump's
 * side of the boundary, and what crosses to a provider is flat records. So
 * the imports at the top of this file are the point: `lib/workspace`,
 * `lib/graph` and friends are reachable from here and from nowhere under
 * `control/`.
 */

export type ResolveOptions = {
  now?: () => number;
  /** Mints snapshot ids. Injected so tests are deterministic. */
  createSnapshotId?: () => string;
  /**
   * Whether this environment may resolve local-only data.
   *
   * Governs one thing: whether a project's filesystem root appears in the
   * snapshot. Defaults to `false`, so a hosted deployment that forgets to
   * pass anything withholds the root rather than publishing the deployer's
   * directory layout to whoever is browsing.
   *
   * Injected rather than read from the environment for the same reason the
   * control service injects its runtime decision: this module is pure, runs
   * in the browser, and must have no path to a decision of its own. The
   * caller with a genuine server context supplies `runtime().allowed`.
   */
  localRuntimeAllowed?: boolean;
};

export type ContextResolutionFailure =
  /** The request is not well-formed. */
  | "invalid-request"
  /** The request's scope names a different account than the world holds. */
  | "owner-mismatch";

export type ContextResolution =
  | { ok: true; snapshot: AgentContextSnapshot }
  | { ok: false; reason: ContextResolutionFailure };

/**
 * Accumulates omissions without letting the record of what was dropped
 * become as large as the thing that was dropped.
 *
 * `count` stays exact however many are recorded; `sourceIds` stops at
 * `MAX_OMISSION_SOURCE_IDS`.
 */
class OmissionLog {
  private readonly entries = new Map<string, { omission: AgentContextOmission; ids: string[] }>();

  add(sourceType: AgentContextSourceType, reason: AgentContextOmissionReason, sourceId: string): void {
    const key = `${sourceType}:${reason}`;
    const existing = this.entries.get(key);

    if (!existing) {
      const ids = [sourceId];
      this.entries.set(key, {
        omission: { sourceType, reason, count: 1, sourceIds: ids },
        ids,
      });
      return;
    }

    existing.omission = { ...existing.omission, count: existing.omission.count + 1 };
    if (existing.ids.length < MAX_OMISSION_SOURCE_IDS) existing.ids.push(sourceId);
    this.entries.set(key, existing);
  }

  drain(): AgentContextOmission[] {
    return [...this.entries.values()]
      .map(({ omission, ids }) => ({ ...omission, sourceIds: [...ids] }))
      .sort(
        (a, b) => a.sourceType.localeCompare(b.sourceType) || a.reason.localeCompare(b.reason)
      );
  }
}

/**
 * The two global budgets, enforced at the moment an item is admitted.
 *
 * Checking here rather than trimming a finished list is what lets the
 * character budget be honest: an item is measured, and either fits and is
 * kept or does not and is reported. A trim pass would have had to build the
 * oversized payload first.
 */
class Budget {
  private items = 0;
  private characters = 0;

  constructor(private readonly limits: AgentContextLimits) {}

  /** Admits `item` if both budgets allow, and says which one refused if not. */
  admit(item: AgentContextItem): "ok" | "limit-items" | "limit-characters" {
    if (this.items >= this.limits.maxItems) return "limit-items";

    const cost = countCharacters(item);
    if (this.characters + cost > this.limits.maxCharacters) return "limit-characters";

    this.items += 1;
    this.characters += cost;
    return "ok";
  }

  get characterCount(): number {
    return this.characters;
  }
}

/** Deduplicates while preserving the caller's order, so a snapshot is reproducible. */
function unique(ids: readonly string[] | undefined): string[] {
  return ids ? [...new Set(ids)] : [];
}

export function resolveContext(
  request: AgentContextRequest,
  world: AgentContextWorld,
  options: ResolveOptions = {}
): ContextResolution {
  if (!isWellFormedRequest(request)) return { ok: false, reason: "invalid-request" };

  // The cross-account gate. Checked before anything is looked up, because
  // every later check trusts that the world belongs to the scope's owner —
  // an id alone is not evidence of ownership, and this is where that stops
  // being an assumption.
  if (world.ownerId !== request.scope.ownerId) return { ok: false, reason: "owner-mismatch" };

  const now = options.now ?? (() => Date.now());
  const createSnapshotId = options.createSnapshotId ?? defaultSnapshotId;
  const localRuntimeAllowed = options.localRuntimeAllowed === true;

  const limits = clampLimits(request.limits);
  const index = indexContextWorld(world);
  const omissions = new OmissionLog();
  const budget = new Budget(limits);
  const items: AgentContextItem[] = [];

  const requested = new Set(request.sources);
  const scopedWorkspaceIds = new Set(request.scope.workspaceIds);
  const scopedProjectIds = new Set(request.scope.projectIds);

  /** Admits an item, recording which budget refused it when one does. */
  function admit(item: AgentContextItem): boolean {
    const verdict = budget.admit(item);
    if (verdict === "ok") {
      items.push(item);
      return true;
    }
    omissions.add(item.sourceType, verdict, item.sourceId);
    return false;
  }

  /**
   * Ids supplied for a source type the request did not list.
   *
   * Reported rather than ignored: a caller that passed `tabIds` but forgot
   * `"tab"` in `sources` has a bug, and a silently empty result is the
   * hardest possible way to find it.
   */
  function rejectUnrequested(sourceType: AgentContextSourceType, ids: readonly string[]): void {
    for (const id of ids) omissions.add(sourceType, "source-not-requested", id);
  }

  const workspaceIds = unique(request.workspaceIds);
  const tabIds = unique(request.tabIds);
  const collectionIds = unique(request.collectionIds);
  const projectIds = unique(request.projectIds);

  /* -------------------------------------------------------------- *
   * Workspaces
   * -------------------------------------------------------------- */

  /**
   * The workspaces that are both asked for and in scope.
   *
   * Computed even when the `workspace` source itself was not requested,
   * because it is the membership set every other source is filtered
   * against — asking for a tab without asking for its workspace is normal,
   * and the tab still has to be inside the scope.
   */
  const targetWorkspaceIds: string[] = [];
  for (const id of workspaceIds) {
    if (!scopedWorkspaceIds.has(id)) {
      omissions.add("workspace", "out-of-scope", id);
      continue;
    }
    if (!index.workspaceById.has(id)) {
      omissions.add("workspace", "not-found", id);
      continue;
    }
    if (targetWorkspaceIds.length >= limits.maxWorkspaces) {
      omissions.add("workspace", "limit-workspaces", id);
      continue;
    }
    targetWorkspaceIds.push(id);
  }

  if (requested.has("workspace")) {
    for (const id of targetWorkspaceIds) {
      const workspace = index.workspaceById.get(id)!;
      const label = sanitizeText(workspace.name) ?? id;
      const collectionCount = world.collections.filter((c) => c.workspaceId === id).length;

      const item: WorkspaceContextItem = {
        sourceType: "workspace",
        sourceId: id,
        label,
        tabCount: workspace.tabs.length,
        collectionCount,
      };
      if (workspace.createdAt) item.createdAt = workspace.createdAt;
      if (workspace.updatedAt) item.updatedAt = workspace.updatedAt;

      admit(item);
    }
  }
  // Note the absence of a `source-not-requested` report for workspaces.
  // Naming a workspace without asking for the `workspace` source is the
  // common case — it is how a caller scopes a tab request — so nothing was
  // refused and there is nothing to report.

  /**
   * Whether a tab is inside this request's reach.
   *
   * The single membership test, used by every source. A tab is reachable
   * when the workspace currently holding it is in the request's *scope* —
   * not merely in `targetWorkspaceIds`, since a caller may name a tab
   * directly without naming its workspace.
   */
  function tabInScope(tabId: string): boolean {
    const workspaceId = index.workspaceIdOfTab.get(tabId);
    return workspaceId !== undefined && scopedWorkspaceIds.has(workspaceId);
  }

  /* -------------------------------------------------------------- *
   * Collections
   * -------------------------------------------------------------- */

  const includedCollectionIds = new Set<string>();

  if (requested.has("collection")) {
    // Explicit ids first, then whatever else belongs to a requested
    // workspace — so a caller that named a collection gets it even if the
    // workspace holds more than the cap allows.
    const candidates = [
      ...collectionIds,
      ...world.collections
        .filter((c) => targetWorkspaceIds.includes(c.workspaceId))
        .map((c) => c.id),
    ];

    for (const id of new Set(candidates)) {
      const collection = index.collectionById.get(id);
      if (!collection) {
        omissions.add("collection", "not-found", id);
        continue;
      }
      if (!scopedWorkspaceIds.has(collection.workspaceId)) {
        omissions.add("collection", "out-of-scope", id);
        continue;
      }
      if (includedCollectionIds.size >= limits.maxCollections) {
        omissions.add("collection", "limit-collections", id);
        continue;
      }

      // Members are bounded here rather than expanded into tab items. A
      // collection attachment says "these tabs are in it"; turning that
      // into full tab records is the caller's separate, counted decision.
      const members = collection.tabIds.filter(tabInScope);
      const kept = members.slice(0, limits.maxCollectionMembers);
      if (members.length > kept.length) {
        for (const dropped of members.slice(limits.maxCollectionMembers)) {
          omissions.add("collection", "limit-collection-members", dropped);
        }
      }

      const item: CollectionContextItem = {
        sourceType: "collection",
        sourceId: id,
        label: sanitizeText(collection.name) ?? id,
        workspaceId: collection.workspaceId,
        tabIds: kept,
        memberCount: members.length,
        membersTruncated: members.length > kept.length,
      };

      if (admit(item)) includedCollectionIds.add(id);
    }
  } else if (collectionIds.length > 0) {
    rejectUnrequested("collection", collectionIds);
  }

  /* -------------------------------------------------------------- *
   * Tabs
   * -------------------------------------------------------------- */

  /**
   * Every tab the request reaches, before the tab cap.
   *
   * Also the input to the relationship and graph sources, which is why it
   * is computed even when `"tab"` was not requested: a graph centred on a
   * tab must be built from the same bounded population, not from the
   * account.
   */
  const reachableTabs: Tab[] = [];
  const seenTabIds = new Set<string>();

  function considerTab(tabId: string, reportMissing: boolean): void {
    if (seenTabIds.has(tabId)) return;
    const tab = index.tabById.get(tabId);
    if (!tab) {
      if (reportMissing) omissions.add("tab", "not-found", tabId);
      return;
    }
    if (!tabInScope(tabId)) {
      if (reportMissing) omissions.add("tab", "out-of-scope", tabId);
      return;
    }
    seenTabIds.add(tabId);
    reachableTabs.push(tab);
  }

  for (const id of tabIds) considerTab(id, true);
  for (const workspaceId of targetWorkspaceIds) {
    for (const tab of index.workspaceById.get(workspaceId)!.tabs) considerTab(tab.id, false);
  }

  const includedTabIds = new Set<string>();

  if (requested.has("tab")) {
    for (const tab of reachableTabs) {
      if (includedTabIds.size >= limits.maxTabs) {
        omissions.add("tab", "limit-tabs", tab.id);
        continue;
      }

      const workspaceId = index.workspaceIdOfTab.get(tab.id)!;
      const redacted = redactUrl(tab.url);

      const item: TabContextItem = {
        sourceType: "tab",
        sourceId: tab.id,
        label: sanitizeText(tab.title) ?? redacted?.url ?? tab.id,
        workspaceId,
        collectionIds: (index.collectionIdsOfTab.get(tab.id) ?? []).filter((id) =>
          // Only collections this request actually resolved. A membership
          // pointer to a collection the caller cannot see would be a
          // one-field leak of what else exists.
          includedCollectionIds.has(id)
        ),
      };

      if (redacted) {
        item.url = redacted.url;
        if (redacted.domain) item.domain = redacted.domain;
        if (redacted.redacted) item.urlRedacted = true;
      } else {
        // `tab.domain` is TabDump's own derived field and is safe even when
        // the stored URL will not parse.
        const domain = sanitizeText(tab.domain);
        if (domain) item.domain = domain;
      }

      if (request.includeNotes === true) {
        const note = sanitizeText(tab.notes, MAX_NOTE_LENGTH);
        if (note) item.note = note;
      }

      if (tab.createdAt) item.createdAt = tab.createdAt;
      if (tab.lastAccessedAt) item.lastAccessedAt = tab.lastAccessedAt;

      if (admit(item)) includedTabIds.add(tab.id);
    }
  } else if (tabIds.length > 0 && !requested.has("relationship") && !requested.has("graph")) {
    // Reported only when the ids genuinely did nothing. A caller asking for
    // relationships or a graph supplies `tabIds` to say *which* tabs to
    // work outward from, and those ids were honoured — just not as tab
    // items. Calling that "not requested" would put a false entry in the
    // audit trail the omission list exists to be.
    rejectUnrequested("tab", tabIds);
  }

  /* -------------------------------------------------------------- *
   * Relationships
   * -------------------------------------------------------------- */

  if (requested.has("relationship")) {
    let kept = 0;
    const seenDependencies = new Set<string>();

    for (const tab of reachableTabs) {
      for (const dependency of index.dependenciesOfTab.get(tab.id) ?? []) {
        if (seenDependencies.has(dependency.id)) continue;
        seenDependencies.add(dependency.id);

        // The rule that stops a relationship from being an expansion
        // mechanism: BOTH endpoints must be in scope. A dependency pointing
        // out of the scope is dropped, not followed — otherwise attaching
        // one workspace would walk into every workspace it happens to link
        // to, and scope would mean nothing.
        if (!tabInScope(dependency.parentTabId) || !tabInScope(dependency.childTabId)) {
          omissions.add("relationship", "out-of-scope", dependency.id);
          continue;
        }

        if (kept >= limits.maxRelationships) {
          omissions.add("relationship", "limit-relationships", dependency.id);
          continue;
        }

        const parent = index.tabById.get(dependency.parentTabId);
        const child = index.tabById.get(dependency.childTabId);
        const parentLabel = sanitizeText(parent?.title) ?? dependency.parentTabId;
        const childLabel = sanitizeText(child?.title) ?? dependency.childTabId;

        const item: RelationshipContextItem = {
          sourceType: "relationship",
          sourceId: dependency.id,
          label: `${parentLabel} → ${childLabel}`,
          relation: "depends-on",
          fromTabId: dependency.parentTabId,
          toTabId: dependency.childTabId,
        };
        if (dependency.type) item.kind = dependency.type;

        if (admit(item)) kept += 1;
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Graph
   * -------------------------------------------------------------- */

  if (requested.has("graph") && request.graph) {
    const depth = Math.max(0, Math.min(Math.floor(request.graph.depth), limits.maxGraphDepth));

    // Built from the reachable population only, so traversal is bounded by
    // the scope before depth even applies. `buildGraphEdges` is TabDump's
    // own edge builder — the graph the agent is told about is the graph the
    // user sees, not a second implementation that could disagree with it.
    const workspaceLookup = buildWorkspaceLookup(
      targetWorkspaceIds.length > 0
        ? targetWorkspaceIds.map((id) => index.workspaceById.get(id)!)
        : world.workspaces.filter((w) => scopedWorkspaceIds.has(w.id))
    );
    const sections: Section[] = world.workspaces
      .filter((w) => scopedWorkspaceIds.has(w.id))
      .flatMap((w) => w.sections ?? []);
    const reachableTabIds = new Set(reachableTabs.map((tab) => tab.id));
    const manualConnections = world.manualConnections.filter(
      (connection) => reachableTabIds.has(connection.a) && reachableTabIds.has(connection.b)
    );

    const edges = buildGraphEdges(
      reachableTabs,
      workspaceLookup,
      DEFAULT_CONNECTION_FILTERS,
      manualConnections,
      sections
    );

    for (const centerTabId of unique(request.graph.centerTabIds)) {
      if (!index.tabById.has(centerTabId)) {
        omissions.add("graph", "not-found", centerTabId);
        continue;
      }
      if (!tabInScope(centerTabId)) {
        omissions.add("graph", "out-of-scope", centerTabId);
        continue;
      }

      const item = buildGraphItem(centerTabId, depth, edges, index, limits, omissions);
      admit(item);
    }
  }

  /* -------------------------------------------------------------- *
   * Projects
   * -------------------------------------------------------------- */

  if (requested.has("project")) {
    let kept = 0;
    for (const id of projectIds) {
      if (!scopedProjectIds.has(id)) {
        omissions.add("project", "out-of-scope", id);
        continue;
      }
      const project = index.projectById.get(id);
      if (!project) {
        omissions.add("project", "not-found", id);
        continue;
      }
      if (kept >= limits.maxProjects) {
        omissions.add("project", "limit-projects", id);
        continue;
      }

      const item: ProjectContextItem = {
        sourceType: "project",
        sourceId: id,
        label: sanitizeText(project.name) ?? id,
        projectId: id,
        authorizedProviderCount: project.providers.length,
      };

      // The hosted fail-closed rule, applied to data rather than execution.
      // A deployed TabDump knows about projects only because a record was
      // synced or restored; publishing the directory layout of whatever
      // machine that came from, to whoever is browsing, is a leak that
      // needs no agent to be involved at all.
      if (localRuntimeAllowed) {
        const root = sanitizeText(project.path);
        if (root) item.root = root;
      } else {
        item.rootWithheld = true;
        omissions.add("project", "hosted-runtime", id);
      }

      if (admit(item)) kept += 1;
    }
  } else if (projectIds.length > 0) {
    rejectUnrequested("project", projectIds);
  }

  /* -------------------------------------------------------------- *
   * Agent activity
   * -------------------------------------------------------------- */

  if (requested.has("agent_activity")) {
    const cap = Math.min(
      request.agentActivity?.limit ?? limits.maxAgentActivity,
      limits.maxAgentActivity
    );

    // Newest first across every in-scope workspace, so a cap of five means
    // the five most recent runs rather than the five oldest of whichever
    // workspace sorted first.
    const candidates = [...scopedWorkspaceIds]
      .flatMap((workspaceId) => [...(index.runsByWorkspace.get(workspaceId) ?? [])])
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

    let kept = 0;
    for (const run of candidates) {
      if (kept >= cap) {
        omissions.add("agent_activity", "limit-agent-activity", run.id);
        continue;
      }

      const agent = index.agentById.get(run.agentId);
      const item: AgentActivityContextItem = {
        sourceType: "agent_activity",
        sourceId: run.id,
        label: sanitizeText(run.title) ?? sanitizeText(agent?.name) ?? run.id,
        runId: run.id,
        workspaceId: run.workspaceId,
        agentName: sanitizeText(agent?.name) ?? "Unknown agent",
        // The provider key is opaque here exactly as it is in the
        // observation domain. There is deliberately no artifact, no path
        // and no event payload: those carry absolute project paths (a
        // `WorkArtifact` id embeds one) and belong to the observation
        // plane, not to a provider's context.
        provider: sanitizeText(agent?.provider) ?? "unknown",
        status: run.status,
        startedAt: run.createdAt,
      };
      if (run.endedAt) item.endedAt = run.endedAt;
      const summary = sanitizeText(run.currentActivity);
      if (summary) item.summary = summary;

      if (admit(item)) kept += 1;
    }
  }

  const drained = omissions.drain();

  const snapshot: AgentContextSnapshot = {
    id: createSnapshotId(),
    capturedAt: now(),
    scope: {
      ownerId: request.scope.ownerId,
      workspaceIds: [...request.scope.workspaceIds],
      projectIds: [...request.scope.projectIds],
    },
    limits,
    requestedSources: [...request.sources],
    items,
    omissions: drained,
    characterCount: budget.characterCount,
    truncated: drained.length > 0,
  };

  return { ok: true, snapshot: deepFreeze(snapshot) };
}

/**
 * One centre's neighbourhood, bounded three ways.
 *
 * `computeLocalDistances` is TabDump's own BFS and carries a visited set, so
 * a cyclic graph terminates for free — which is why this does not
 * reimplement traversal. What it adds is the two count caps the view layer
 * never needed: depth alone is not a bound when one hop from a popular
 * domain reaches four hundred tabs.
 *
 * Nodes are taken nearest-first so a truncated neighbourhood is the useful
 * part of it, and edges are kept only between surviving nodes so the result
 * is always a coherent subgraph rather than a set of edges pointing at
 * nodes that were cut.
 */
function buildGraphItem(
  centerTabId: string,
  depth: number,
  edges: GraphEdge[],
  index: AgentContextIndex,
  limits: AgentContextLimits,
  omissions: OmissionLog
): GraphContextItem {
  const distances = computeLocalDistances(centerTabId, edges, traversalDepth(depth));

  const ordered = [...distances.entries()]
    // Depth 0 means the centre alone. `computeLocalDistances` has no such
    // mode (a depth of 0 would walk nothing at all, including the centre's
    // own entry being the only one), so the filter is applied here.
    .filter(([, distance]) => distance <= depth)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  const keptIds = new Set<string>();
  const nodes: GraphContextNode[] = [];

  for (const [tabId, distance] of ordered) {
    if (nodes.length >= limits.maxGraphNodes) {
      omissions.add("graph", "limit-graph-nodes", tabId);
      continue;
    }
    const tab = index.tabById.get(tabId);
    if (!tab) continue;

    const node: GraphContextNode = {
      tabId,
      label: sanitizeText(tab.title) ?? tabId,
      distance,
    };
    const domain = sanitizeText(tab.domain);
    if (domain) node.domain = domain;

    nodes.push(node);
    keptIds.add(tabId);
  }

  const contained = edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));
  const keptEdges: GraphContextEdge[] = [];

  for (const edge of contained) {
    if (keptEdges.length >= limits.maxGraphEdges) {
      omissions.add("graph", "limit-graph-edges", edge.id);
      continue;
    }
    keptEdges.push({ fromTabId: edge.source, toTabId: edge.target, reasons: [...edge.reasons] });
  }

  const centerTab = index.tabById.get(centerTabId);

  return {
    sourceType: "graph",
    sourceId: `graph:${centerTabId}:${depth}`,
    label: sanitizeText(centerTab?.title) ?? centerTabId,
    centerTabId,
    depth,
    nodes,
    edges: keptEdges,
    nodesTruncated: nodes.length < ordered.length,
    edgesTruncated: keptEdges.length < contained.length,
  };
}

/**
 * The depth to actually walk, as the canonical `GraphDepth` union.
 *
 * `"infinite"` is unreachable by construction — it is the one member of
 * that union a bounded context may never use, and the mapping here is total
 * without it. A requested depth of 0 still walks one hop, because the
 * traversal's own minimum is one; the extra ring is discarded by the
 * distance filter above rather than by asking for an impossible traversal.
 */
function traversalDepth(depth: number): GraphDepth {
  if (depth >= 3) return 3;
  if (depth === 2) return 2;
  return 1;
}

let snapshotCounter = 0;

/**
 * A snapshot id.
 *
 * Not derived from the content: two resolutions of identical data at
 * different times are genuinely different snapshots, and giving them one id
 * would make "which context did this run see" unanswerable.
 */
function defaultSnapshotId(): string {
  snapshotCounter += 1;
  return `ctx-${Date.now().toString(36)}-${snapshotCounter.toString(36)}`;
}

/**
 * Freezes a snapshot all the way down.
 *
 * `readonly` is a compile-time claim and a snapshot outlives the compiler —
 * it is held across an async provider call, handed to an adapter, and
 * potentially re-read after a refresh minted its successor. Freezing makes
 * the immutability real at runtime, so a mutation is a thrown error in
 * strict mode rather than a run whose context changed under it.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}
