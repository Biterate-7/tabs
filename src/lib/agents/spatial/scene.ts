import { relativePathBasename } from "@/lib/agents/paths";
import { isTerminalRunStatus } from "@/lib/agents/types";
import {
  ATTENTION_STATUSES,
  RECENT_RUN_WINDOW_MS,
  agentSpatialId,
  artifactSpatialId,
  emptyAgentSpatialScene,
  runSpatialId,
  tabSpatialId,
} from "./types";
import type {
  AgentSpatialEdge,
  AgentSpatialFilter,
  AgentSpatialNodeUnion,
  AgentSpatialScene,
  ArtifactSpatialNode,
  BuildSceneInput,
  RunSpatialNode,
  SpatialId,
} from "./types";
import type {
  AgentRun,
  AgentRunArtifactLink,
  AgentRunLink,
  AgentState,
  AgentRunStatus,
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
  const { workspaceId, filter, selectedId, now } = input;
  if (!workspaceId) return emptyAgentSpatialScene();

  const workspaceRuns = state.runs.filter((run) => run.workspaceId === workspaceId);
  if (workspaceRuns.length === 0) return emptyAgentSpatialScene();

  const visibleRuns = workspaceRuns.filter((run) => runMatchesFilter(run, filter, now));
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
      updatedAt: run.updatedAt,
      createdAt: run.createdAt,
    };
    if (run.currentActivity) node.activity = run.currentActivity;
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

  return { nodes, edges, hiddenRunCount };
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
