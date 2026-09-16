import { relativePathBasename } from "@/lib/agents/paths";
import { isTerminalRunStatus } from "@/lib/agents/types";
import {
  ATTENTION_STATUSES,
  RECENT_RUN_WINDOW_MS,
  agentSpatialId,
  artifactSpatialId,
  emptyAgentSpatialScene,
  isWorkItemSpatialId,
  runSpatialId,
  tabSpatialId,
  workItemSpatialId,
} from "./types";
import type {
  AgentSpatialEdge,
  AgentSpatialFilter,
  AgentSpatialNodeUnion,
  AgentSpatialScene,
  ArtifactSpatialNode,
  BuildSceneInput,
  RunSpatialNode,
  WorkItemSummary,
  SpatialId,
} from "./types";
import type {
  AgentRun,
  AgentRunArtifactLink,
  AgentRunLink,
  AgentState,
  AgentRunStatus,
  AgentWorkItem,
  AgentWorkItemStatus,
} from "@/lib/agents/types";

/**
 * Domain state → what the canvas should draw.
 *
 * A pure function, and the only place visibility is decided. Keeping it out of
 * components means the rules can be tested without rendering anything, and
 * means there is exactly one answer to "why is that run on screen" rather than
 * one per component that happened to filter.
 *
 * The governing idea is **progressive disclosure**. A workspace accumulates
 * agent history indefinitely; rendering all of it would turn the canvas into a
 * database dump, which is the specific failure this phase is meant to avoid.
 * So the default shows live work plus what finished recently, and selecting
 * something widens the view around it rather than everywhere at once.
 */

/** Whether a run passes the filter, before any selection-based widening. */
export function runMatchesFilter(
  run: AgentRun,
  filter: AgentSpatialFilter,
  now: number
): boolean {
  const terminal = isTerminalRunStatus(run.status);

  switch (filter) {
    case "all":
      return true;
    case "waiting":
      return run.status === "waiting";
    case "attention":
      return (ATTENTION_STATUSES as readonly string[]).includes(run.status);
    case "finished":
      return terminal;
    case "active":
    default:
      // Live work, plus work that finished recently enough to still be the
      // thing the user was just looking at.
      if (!terminal) return true;
      return now - (run.endedAt ?? run.updatedAt) <= RECENT_RUN_WINDOW_MS;
  }
}

/**
 * The worst-attention status among a set of runs, for an agent's summary dot.
 *
 * Ordered by how much it wants a human: a failure outranks a live run, which
 * outranks a finished one. An agent with nothing visible reads `idle` rather
 * than borrowing the status of a run that is not on screen.
 */
function summarizeStatus(runs: AgentRun[]): AgentRunStatus | "idle" {
  const order: (AgentRunStatus | "idle")[] = [
    "failed",
    "blocked",
    "working",
    "waiting",
    "cancelled",
    "completed",
    "idle",
  ];

  let best: AgentRunStatus | "idle" = "idle";
  let bestRank = order.length;

  for (const run of runs) {
    const rank = order.indexOf(run.status);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      best = run.status;
    }
  }

  return best;
}

/**
 * Which artifacts to show.
 *
 * Not every artifact a workspace has ever seen — that is the wall of noise.
 * An artifact appears when it belongs to the selected run, or when its run is
 * itself selected or is the only visible one. Everything else stays in the
 * domain, reachable through selection, and is counted on its run instead.
 */
function visibleArtifactIds(
  links: AgentRunArtifactLink[],
  visibleRunIds: Set<string>,
  selectedRunIds: Set<string>
): Set<string> {
  const out = new Set<string>();

  for (const link of links) {
    if (!visibleRunIds.has(link.runId)) continue;
    if (!selectedRunIds.has(link.runId)) continue;
    out.add(link.artifactId);
  }

  return out;
}

/**
 * Builds the scene.
 *
 * Single pass per relation, with lookups by Set/Map rather than nested
 * `find` — a workspace may hold hundreds of runs and artifacts, and a
 * quadratic scan here would run on every render.
 */
export function buildAgentSpatialScene(
  state: AgentState,
  input: BuildSceneInput
): AgentSpatialScene {
  const { workspaceId, filter, providerFilter, selectedId, now } = input;
  if (!workspaceId) return emptyAgentSpatialScene();

  const workspaceRuns = state.runs.filter((run) => run.workspaceId === workspaceId);
  if (workspaceRuns.length === 0) return emptyAgentSpatialScene();

  // Which providers have worked here, taken before any filter so that a
  // provider the user has just filtered away does not vanish from the control
  // they would use to bring it back.
  const providerByAgentId = new Map(state.agents.map((agent) => [agent.id, agent.provider]));
  const providers: string[] = [];
  for (const run of workspaceRuns) {
    const provider = providerByAgentId.get(run.agentId);
    if (provider && !providers.includes(provider)) providers.push(provider);
  }

  const visibleRuns = workspaceRuns.filter(
    (run) =>
      runMatchesFilter(run, filter, now) &&
      // An unknown provider filter hides everything rather than silently
      // showing all runs: a filter that quietly stopped applying would be
      // read as "this provider did all of this".
      (!providerFilter || providerByAgentId.get(run.agentId) === providerFilter)
  );
  const hiddenRunCount = workspaceRuns.length - visibleRuns.length;
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));

  // Selecting a run discloses its files. Selecting the only visible run, or
  // having exactly one, does the same without a click — a workspace with one
  // run should show its work, not an unexpanded dot.
  const selectedRunIds = new Set<string>();
  if (selectedId?.startsWith("run:")) {
    const runId = selectedId.slice("run:".length);
    if (visibleRunIds.has(runId)) selectedRunIds.add(runId);
  }
  if (selectedRunIds.size === 0 && visibleRuns.length === 1) {
    selectedRunIds.add(visibleRuns[0].id);
  }
  // Selecting an artifact discloses the runs around it, so its own run's
  // neighbourhood opens too.
  if (selectedId?.startsWith("artifact:")) {
    const artifactId = selectedId.slice("artifact:".length);
    for (const link of state.artifactLinks) {
      if (link.artifactId === artifactId && visibleRunIds.has(link.runId)) {
        selectedRunIds.add(link.runId);
      }
    }
  }

  const artifactLinks = state.artifactLinks.filter((link) => visibleRunIds.has(link.runId));
  const tabLinks = state.links.filter((link) => visibleRunIds.has(link.runId));

  const shownArtifactIds = visibleArtifactIds(artifactLinks, visibleRunIds, selectedRunIds);
  const artifactsById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));

  // Counts come from ALL of a run's links, not only the disclosed ones, so a
  // collapsed run still says how much work it represents.
  const artifactCounts = countBy(artifactLinks, (link) => link.runId, (link) => link.artifactId);
  const tabCounts = countBy(tabLinks, (link) => link.runId, (link) => link.tabId);
  const runsPerArtifact = countBy(
    artifactLinks,
    (link) => link.artifactId,
    (link) => link.runId
  );

  // Work items of visible runs only, grouped once. A run hidden by the filter
  // contributes none — visibility is inherited, never independent, so an item
  // can never outlive the run it explains.
  const workItemsByRun = new Map<string, AgentWorkItem[]>();
  for (const item of state.workItems) {
    if (!visibleRunIds.has(item.runId)) continue;
    const bucket = workItemsByRun.get(item.runId);
    if (bucket) bucket.push(item);
    else workItemsByRun.set(item.runId, [item]);
  }
  for (const bucket of workItemsByRun.values()) bucket.sort(byOldestWorkItem);

  const nodes: AgentSpatialNodeUnion[] = [];
  const edges: AgentSpatialEdge[] = [];

  // Agents that actually have a visible run here. An agent with no work in
  // this workspace is not this workspace's business.
  const runsByAgent = new Map<string, AgentRun[]>();
  for (const run of visibleRuns) {
    const bucket = runsByAgent.get(run.agentId);
    if (bucket) bucket.push(run);
    else runsByAgent.set(run.agentId, [run]);
  }

  const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));

  for (const [agentId, runs] of runsByAgent) {
    const agent = agentsById.get(agentId);
    if (!agent) continue;

    nodes.push({
      kind: "agent",
      id: agentSpatialId(agentId),
      agentId,
      label: agent.name,
      provider: agent.provider,
      activeRunCount: runs.filter((run) => !isTerminalRunStatus(run.status)).length,
      totalRunCount: workspaceRuns.filter((run) => run.agentId === agentId).length,
      status: summarizeStatus(runs),
      createdAt: agent.createdAt,
    });
  }

  for (const run of visibleRuns) {
    const agent = agentsById.get(run.agentId);
    const node: RunSpatialNode = {
      kind: "run",
      id: runSpatialId(run.id),
      runId: run.id,
      agentId: run.agentId,
      // A run without a title is still a run; naming it by its agent beats an
      // empty label or a raw session id.
      label: run.title ?? agent?.name ?? "Agent run",
      provider: agent?.provider ?? "",
      status: run.status,
      tabCount: tabCounts.get(run.id)?.size ?? 0,
      artifactCount: artifactCounts.get(run.id)?.size ?? 0,
      workItemCount: workItemsByRun.get(run.id)?.length ?? 0,
      updatedAt: run.updatedAt,
      createdAt: run.createdAt,
    };
    if (run.currentActivity) node.activity = run.currentActivity;

    // Progress and the primary title are derived from the run's real items.
    // Both are omitted entirely when the run has none — a run nobody reported
    // a plan for shows no ring and no subtitle, rather than an empty ring and
    // a placeholder, because "0 of 0" reads as a measurement and there was no
    // measurement.
    const progress = runWorkProgress(workItemsByRun.get(run.id));
    if (progress) node.workProgress = progress;

    const primary = primaryWorkItem(workItemsByRun.get(run.id));
    if (primary) node.primaryWorkItemTitle = primary.title;

    nodes.push(node);

    if (agentsById.has(run.agentId)) {
      edges.push({
        id: `owns:${run.agentId}:${run.id}`,
        source: agentSpatialId(run.agentId),
        target: runSpatialId(run.id),
        kind: "owns",
      });
    }
  }

  for (const artifactId of shownArtifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) continue;

    const node: ArtifactSpatialNode = {
      kind: "artifact",
      id: artifactSpatialId(artifactId),
      artifactId,
      label: relativePathBasename(artifact.relativePath),
      relativePath: artifact.relativePath,
      runCount: runsPerArtifact.get(artifactId)?.size ?? 0,
      updatedAt: artifact.updatedAt,
      createdAt: artifact.createdAt,
    };
    nodes.push(node);
  }

  for (const link of artifactLinks) {
    if (!shownArtifactIds.has(link.artifactId)) continue;
    edges.push({
      id: `artifact:${link.id}`,
      source: runSpatialId(link.runId),
      target: artifactSpatialId(link.artifactId),
      kind: link.role,
    });
  }

  // Tab edges point at the EXISTING tab nodes on the canvas, by their own
  // spatial id. The agent layer never draws a tab — tabs are the tab layer's,
  // and duplicating them would put the same page on screen twice.
  for (const link of tabLinks) {
    if (selectedRunIds.size > 0 && !selectedRunIds.has(link.runId)) continue;
    edges.push({
      id: `tab:${link.id}`,
      source: runSpatialId(link.runId),
      target: tabSpatialId(link.tabId),
      kind: link.role,
    });
  }

  // Flattened last, in run order, so the list reads the way the canvas does.
  const workItems: WorkItemSummary[] = [];
  for (const run of visibleRuns) {
    for (const item of workItemsByRun.get(run.id) ?? []) {
      const summary: WorkItemSummary = {
        id: workItemSpatialId(item.id),
        workItemId: item.id,
        runId: item.runId,
        runSpatialId: runSpatialId(item.runId),
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      if (item.summary) summary.summary = item.summary;
      if (item.progress) summary.progress = item.progress;
      if (item.startedAt !== undefined) summary.startedAt = item.startedAt;
      if (item.completedAt !== undefined) summary.completedAt = item.completedAt;
      workItems.push(summary);
    }
  }

  return { nodes, edges, workItems, hiddenRunCount, providers };
}

/**
 * Oldest first, id breaking ties — a plan read in the order it was made.
 *
 * Duplicated from selectors.ts rather than imported because that one is
 * private to its module and this one orders scene-side copies; keeping them
 * separate avoids exporting an ordering primitive that neither module owns.
 */
function byOldestWorkItem(a: AgentWorkItem, b: AgentWorkItem): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * How far a set of work items has got.
 *
 * The scene-side twin of `getRunWorkProgress`, operating on the already
 * grouped-and-filtered bucket so the scene builder stays single-pass. Same
 * rules: cancelled items count toward neither side, and a run with nothing
 * countable gets undefined rather than 0 / 0.
 */
function runWorkProgress(
  items: AgentWorkItem[] | undefined
): { completed: number; total: number } | undefined {
  if (!items?.length) return undefined;

  let completed = 0;
  let total = 0;
  for (const item of items) {
    if (item.status === "cancelled") continue;
    total += 1;
    if (item.status === "completed") completed += 1;
  }

  return total === 0 ? undefined : { completed, total };
}

/**
 * The item that best represents what a run is doing.
 *
 * Same attention ordering as the domain's `getPrimaryWorkItem`: active work
 * outranks blocked, which outranks not-yet-started, which outranks finished.
 * Items arrive already sorted oldest-first, so a stable scan suffices.
 */
function primaryWorkItem(items: AgentWorkItem[] | undefined): AgentWorkItem | undefined {
  if (!items?.length) return undefined;

  const rank: Record<AgentWorkItemStatus, number> = {
    active: 0,
    blocked: 1,
    pending: 2,
    completed: 3,
    cancelled: 4,
  };

  let best = items[0];
  for (const item of items) {
    if (rank[item.status] < rank[best.status]) best = item;
  }
  return best;
}

/**
 * The run a work-item selection should focus.
 *
 * Work items have no body on the canvas, so "focus this work item" means
 * "focus the run that owns it" — the existing focus abstraction, reached with
 * a run spatial id, rather than a second camera path for a node that does not
 * exist. Returns null when the selection is not a work item, or names one the
 * current scene does not contain.
 */
export function runIdForWorkItemSelection(
  scene: AgentSpatialScene,
  selectedId: SpatialId | null | undefined
): SpatialId | null {
  if (!isWorkItemSpatialId(selectedId)) return null;
  return scene.workItems.find((item) => item.id === selectedId)?.runSpatialId ?? null;
}

/**
 * Groups by one key and counts DISTINCT values of another.
 *
 * Distinct matters: a run that both inspected and edited one file holds two
 * links to it, and "2 files" would be wrong.
 */
function countBy<T>(
  items: T[],
  keyOf: (item: T) => string,
  valueOf: (item: T) => string
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();

  for (const item of items) {
    const key = keyOf(item);
    let bucket = out.get(key);
    if (!bucket) {
      bucket = new Set();
      out.set(key, bucket);
    }
    bucket.add(valueOf(item));
  }

  return out;
}

/**
 * The edges that should be drawn prominently, given what is selected.
 *
 * Returned as a set of edge ids rather than by mutating the scene, so the
 * renderer decides how to express emphasis and the model stays presentational-
 * detail-free. With nothing selected, structural edges carry the picture and
 * relationship edges stay quiet; a dense workspace is otherwise unreadable.
 */
export function emphasizedEdgeIds(
  scene: AgentSpatialScene,
  selectedId: SpatialId | null | undefined
): Set<string> {
  if (!selectedId) {
    return new Set(scene.edges.filter((edge) => edge.kind === "owns").map((edge) => edge.id));
  }

  return new Set(
    scene.edges
      .filter((edge) => edge.source === selectedId || edge.target === selectedId)
      .map((edge) => edge.id)
  );
}

/** The tab ids the agent layer wants to draw an edge to, so the canvas can resolve them. */
export function linkedTabIds(scene: AgentSpatialScene): Set<string> {
  const out = new Set<string>();
  for (const edge of scene.edges) {
    if (edge.target.startsWith("tab:")) out.add(edge.target.slice("tab:".length));
  }
  return out;
}

/** Convenience for consumers that hold links rather than a scene. */
export function tabLinksForRun(links: AgentRunLink[], runId: string): AgentRunLink[] {
  return links.filter((link) => link.runId === runId);
}
