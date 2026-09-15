import type {
  Agent,
  AgentRun,
  AgentRunArtifactRole,
  AgentRunLinkRole,
  AgentRunStatus,
  AgentWorkItemStatus,
  WorkArtifact,
} from "@/lib/agents/types";

/**
 * The presentation model for agent work on the workspace canvas.
 *
 * Deliberately a SEPARATE model from `GraphNode`, which is
 * `{ id, tab, workspaceId, workspaceName }` and exists to describe a tab.
 * Widening it into `Tab | Agent | Run | Artifact` would put four unrelated
 * shapes behind one name and force every existing tab code path to re-narrow
 * it — so agents get their own spatial vocabulary, and the two layers meet
 * only at the renderer.
 *
 * Nothing here is provider-specific. A node knows a provider only as a string
 * to print; no consumer of this module may branch on which provider it is.
 */

/**
 * A spatial id, namespaced by kind.
 *
 * Namespaced because a run id and an artifact id are both opaque strings from
 * the same generator, and a position map keyed by the bare value would let one
 * silently inherit the other's coordinates. Derived from the domain id — never
 * an array index, never a random value minted during render — so a node keeps
 * its identity across rerenders, polls, workspace switches and reloads.
 */
export type SpatialId = string;

export function agentSpatialId(agentId: string): SpatialId {
  return `agent:${agentId}`;
}

export function runSpatialId(runId: string): SpatialId {
  return `run:${runId}`;
}

export function artifactSpatialId(artifactId: string): SpatialId {
  return `artifact:${artifactId}`;
}

export function tabSpatialId(tabId: string): SpatialId {
  return `tab:${tabId}`;
}

/**
 * A work item's selection id.
 *
 * Namespaced like the rest, but note what it is *not*: a work item is never
 * an entry in `AgentSpatialScene.nodes`, so nothing ever places it, draws it
 * as a card, or hit-tests it on the canvas. This id exists purely so a work
 * item can be **selected** — from the inspector list or from a search result
 * — and so that selection can be told apart from a run's.
 *
 * That is the whole of Phase 15's spatial footprint, and it is deliberately
 * this small. Work items are numerous (a plan can be dozens), they are
 * meaningful only in relation to their run, and giving each one a body on the
 * canvas would bury the runs it is supposed to explain. Selecting one focuses
 * its owning run instead — see `runIdForWorkItemSelection`.
 */
export function workItemSpatialId(workItemId: string): SpatialId {
  return `workitem:${workItemId}`;
}

export function isWorkItemSpatialId(id: SpatialId | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("workitem:");
}

/** The domain id inside a work item selection id, or null if it is not one. */
export function workItemIdFromSpatialId(id: SpatialId | null | undefined): string | null {
  if (!isWorkItemSpatialId(id)) return null;
  const value = (id as string).slice("workitem:".length);
  return value || null;
}

/**
 * What the inspector and search need to know about one work item.
 *
 * Carried on the scene rather than in `nodes`, because it is presentation
 * data for a *list*, not a body with a position. Everything here is already
 * sanitised domain state; there is no field that could hold provider text.
 */
export type WorkItemSummary = {
  id: SpatialId;
  workItemId: string;
  runId: string;
  /** The owning run's spatial id, so selecting this can focus that. */
  runSpatialId: SpatialId;
  title: string;
  summary?: string;
  status: AgentWorkItemStatus;
  /** Explicit provider-counted progress only. Usually absent — see the domain notes. */
  progress?: { completed: number; total: number };
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type AgentSpatialNodeKind = "agent" | "run" | "artifact";

/** The agent identity itself — one per provider, however many runs it has. */
export type AgentSpatialNode = {
  kind: "agent";
  id: SpatialId;
  agentId: string;
  label: string;
  provider: string;
  /** Runs of this agent that are still live, in this workspace. */
  activeRunCount: number;
  totalRunCount: number;
  /** Worst-attention status among its visible runs, for an at-a-glance state. */
  status: AgentRunStatus | "idle";
  /** Immutable; the layout's ordering key, for the same reason as a run's. */
  createdAt: number;
};

/** One session. The primary operational object of the whole feature. */
export type RunSpatialNode = {
  kind: "run";
  id: SpatialId;
  runId: string;
  agentId: string;
  label: string;
  provider: string;
  status: AgentRunStatus;
  /** Already-sanitised one-liner from the domain. Never raw provider text. */
  activity?: string;
  tabCount: number;
  artifactCount: number;
  /** How many work items this run has. 0 when none have been observed. */
  workItemCount: number;
  /**
   * How far the run has got through them, when it has any.
   *
   * Derived from real per-item statuses by `getRunWorkProgress` — never from
   * event volume or elapsed time. Undefined when the run has no work items,
   * and the renderer then draws no ring at all rather than an empty one.
   */
  workProgress?: { completed: number; total: number };
  /**
   * The work item that best represents what this run is doing right now.
   *
   * A label only. The canvas shows it under the run's own title so a glance
   * says *what* is being worked on, not merely that something is.
   */
  primaryWorkItemTitle?: string;
  updatedAt: number;
  /**
   * Immutable, and the key layout orders by.
   *
   * Ordering by creation rather than by id is what makes placement
   * append-only: a newly discovered run always has the largest value, so it
   * lands after everything already on screen instead of sorting into the
   * middle and pushing its neighbours down. See ./placement.ts.
   */
  createdAt: number;
};

/** A project file a run worked on. Identity only — never contents. */
export type ArtifactSpatialNode = {
  kind: "artifact";
  id: SpatialId;
  artifactId: string;
  /** Basename, for the label. */
  label: string;
  /** Project-relative path. Never absolute — see lib/agents/paths.ts. */
  relativePath: string;
  /** How many runs in this workspace have touched it. */
  runCount: number;
  updatedAt: number;
  /** Immutable; the layout's ordering key, for the same reason as a run's. */
  createdAt: number;
};

export type AgentSpatialNodeUnion = AgentSpatialNode | RunSpatialNode | ArtifactSpatialNode;

/**
 * What an edge means.
 *
 * `owns` is structural (agent → its run); the rest are the domain's own
 * relationship roles, carried through unchanged so the picture says what the
 * data says. They stay distinguishable rather than collapsing into one
 * undifferentiated line.
 */
export type AgentEdgeKind =
  | "owns"
  | AgentRunLinkRole
  | AgentRunArtifactRole;

export type AgentSpatialEdge = {
  id: string;
  source: SpatialId;
  target: SpatialId;
  kind: AgentEdgeKind;
};

/** Everything the canvas needs to draw the agent layer for one workspace. */
export type AgentSpatialScene = {
  nodes: AgentSpatialNodeUnion[];
  edges: AgentSpatialEdge[];
  /**
   * The work items of every visible run, oldest first.
   *
   * Deliberately NOT in `nodes`. Placement, hit-testing and the force-free
   * invariant all operate on `nodes`, and keeping work items out of it is
   * what guarantees — structurally, not by convention — that adding a work
   * item cannot move anything already on screen.
   *
   * Visibility is inherited from the owning run: a work item is listed when
   * its run passes the current filter, and hidden when it does not. There is
   * no separate work-item filter, because an item detached from its run's
   * visibility would be a row the user cannot navigate to.
   */
  workItems: WorkItemSummary[];
  /**
   * Runs that exist in this workspace but are filtered out of view.
   *
   * Kept as a count rather than dropped silently: "3 completed runs hidden" is
   * information, and a user who cannot tell the difference between "no agent
   * work" and "no agent work matching this filter" will read the empty canvas
   * as the former.
   */
  hiddenRunCount: number;
};

export function emptyAgentSpatialScene(): AgentSpatialScene {
  return { nodes: [], edges: [], workItems: [], hiddenRunCount: 0 };
}

/**
 * Which runs are on the canvas.
 *
 * Deliberately small and status-shaped, matching the domain's own vocabulary
 * rather than inventing a second one. A workspace with months of history must
 * not open as a wall of finished work, so the default shows what is live plus
 * what finished recently.
 */
export type AgentSpatialFilter = "active" | "all" | "waiting" | "finished" | "attention";

export const AGENT_SPATIAL_FILTERS: readonly AgentSpatialFilter[] = [
  "active",
  "waiting",
  "attention",
  "finished",
  "all",
] as const;

export const DEFAULT_AGENT_SPATIAL_FILTER: AgentSpatialFilter = "active";

export function isAgentSpatialFilter(value: unknown): value is AgentSpatialFilter {
  return typeof value === "string" && (AGENT_SPATIAL_FILTERS as readonly string[]).includes(value);
}

/** Human labels for the filter control. Provider-neutral. */
export const AGENT_FILTER_LABELS: Record<AgentSpatialFilter, string> = {
  active: "Active",
  waiting: "Waiting",
  attention: "Needs attention",
  finished: "Finished",
  all: "All",
};

/**
 * How long a finished run stays in the default view.
 *
 * Long enough that work finished while the user was in another workspace is
 * still there when they come back; short enough that last week's runs do not
 * crowd today's.
 */
export const RECENT_RUN_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Statuses that mean a run stopped in a way worth noticing. */
export const ATTENTION_STATUSES: readonly AgentRunStatus[] = ["failed", "blocked"] as const;

/** Inputs to building a scene. Everything is domain state the caller already has. */
export type BuildSceneInput = {
  agents: Agent[];
  runs: AgentRun[];
  artifacts: WorkArtifact[];
  workspaceId: string;
  filter: AgentSpatialFilter;
  /** The currently selected spatial node, which widens what is disclosed around it. */
  selectedId?: SpatialId | null;
  /** Clock, injected — used to decide what counts as recent. */
  now: number;
};
