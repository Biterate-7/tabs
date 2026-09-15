import type {
  Agent,
  AgentRun,
  AgentRunArtifactRole,
  AgentRunLinkRole,
  AgentRunStatus,
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
  return { nodes: [], edges: [], hiddenRunCount: 0 };
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
