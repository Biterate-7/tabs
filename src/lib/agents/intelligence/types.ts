import type {
  AgentEventKind,
  AgentRunArtifactRole,
  AgentRunStatus,
  AgentWorkItemProgress,
  AgentWorkItemStatus,
} from "@/lib/agents/types";

/**
 * The derived intelligence layer.
 *
 * Phases 11-15 answer *who* ran, *when*, *what files and tabs were touched*,
 * *where that sits on the canvas*, and *what work was planned*. What none of
 * them answer is the question the command centre exists for:
 *
 *     what is happening in my workspace, and what has it touched?
 *
 * Phase 16 answers it by **reading** those entities, never by storing a new
 * one. Everything in this file is a read model: computed on demand from
 * `AgentState`, never persisted, never written back. Delete this whole
 * directory and the agent domain is untouched - no migration, no lost data,
 * no dangling reference. That property is the design, not a side effect: an
 * intelligence layer that owned state would be a second source of truth for
 * facts the domain already holds, and the two would eventually disagree.
 *
 * ## The presentation boundary
 *
 * These models are client-visible - they feed the inspector. So they repeat
 * the boundary the scene already draws (see spatial/types.ts): three fields
 * are **stored but never rendered**, and none of them appears here.
 *
 * | field | phase | why it is stored | why it is absent here |
 * |---|---|---|---|
 * | `AgentRun.externalId` | 11 | session identity | a provider session id is not a caption |
 * | `WorkArtifact.projectPath` | 13 | artifact identity | it is an ABSOLUTE local path |
 * | `AgentWorkItem.externalId` | 15 | task identity | a provider task id is not a caption |
 *
 * `projectPath` is the load-bearing one. A read model that carried the raw
 * `WorkArtifact` through would put an absolute local path in front of the user
 * the first time an inspector rendered it, silently undoing Phase 13. So the
 * reference types below are not ceremony - they are where that cannot happen.
 */

/**
 * A run, as intelligence reports it.
 *
 * Structurally `AgentRun` minus `externalId` and minus `workspaceId`: the
 * former must not be rendered, and the latter is already known to any caller
 * (every selector here is workspace-scoped, so carrying it would only invite
 * a consumer to trust the copy over the scope it asked for).
 */
export type RunReference = {
  runId: string;
  agentId: string;
  status: AgentRunStatus;
  title?: string;
  /** Already-sanitised one-liner from the domain. Never raw provider text. */
  currentActivity?: string;
  createdAt: number;
  updatedAt: number;
  /** Present exactly when the domain says the run ended. Never inferred. */
  endedAt?: number;
};

/**
 * A work item, as intelligence reports it.
 *
 * `AgentWorkItem` minus `externalId` and `workspaceId`, for the same two
 * reasons. `progress` here is the provider's own explicit count - almost
 * always absent, and never to be confused with the derived run progress on
 * `AgentRunSummary`.
 */
export type WorkItemReference = {
  workItemId: string;
  runId: string;
  title: string;
  summary?: string;
  status: AgentWorkItemStatus;
  /** Explicit provider-counted progress only. See the Phase 15 domain notes. */
  progress?: AgentWorkItemProgress;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

/**
 * A file, as intelligence reports it.
 *
 * `WorkArtifact` minus `projectPath` - the absolute local root. What remains
 * is project-relative and safe to render, which is exactly the split Phase 13
 * established and `ArtifactSpatialNode` already relies on.
 */
export type ArtifactReference = {
  artifactId: string;
  /** Project-relative, forward-slashed. Never absolute. */
  relativePath: string;
  updatedAt: number;
};

/**
 * An event, as intelligence reports it.
 *
 * `AgentEvent` minus `sourceId` - the provider's own id for the record this
 * event was read from. It is stored so that re-reading a transcript does not
 * append the same line twice, and it is not a caption, so it stops here for
 * the same reason the three fields in the table above do.
 */
export type EventReference = {
  eventId: string;
  kind: AgentEventKind;
  /** Already-normalised and length-bounded by the domain. Never raw provider text. */
  summary: string;
  timestamp: number;
};

/** A file plus how one run touched it. A run may hold several roles on one file. */
export type ArtifactImpact = {
  artifact: ArtifactReference;
  /** Every role this run holds on this file - a file can be both inspected and edited. */
  roles: AgentRunArtifactRole[];
};

/**
 * Per-status counts of one run's work items.
 *
 * Exhaustive and mutually exclusive: every item lands in exactly one bucket,
 * and the five sum to `total`. Kept as a named type because both the run
 * summary and the activity card report it, and two independently spelled
 * count objects would eventually drift.
 */
export type WorkItemCounts = {
  total: number;
  pending: number;
  active: number;
  blocked: number;
  completed: number;
  cancelled: number;
};

/**
 * What one run amounts to.
 *
 * Note what `status` is and is not: it is **the run's own status, copied**,
 * never recomputed from work items or events. A summary that derived its own
 * status would be the second source of truth this layer exists to avoid - and
 * it would be free to disagree with the run card sitting next to it.
 *
 * `progress` is the derived, evidence-based ratio (Phase 15's rule: cancelled
 * items count toward neither side; a run with nothing countable gets
 * `undefined`, never `0 / 0`).
 */
export type AgentRunSummary = {
  runId: string;
  agentId: string;
  status: AgentRunStatus;
  workItems: WorkItemCounts;
  /** Derived from real item statuses. Absent when the run has no countable items. */
  progress?: AgentWorkItemProgress;
  /** Distinct files this run touched. */
  artifactCount: number;
  contextTabCount: number;
  producedTabCount: number;
  /**
   * The newest timestamp any observed evidence carries for this run.
   *
   * A maximum over timestamps that already exist - the run's own `updatedAt`,
   * its newest event, its work items, its artifact links. It is never `now`,
   * never a wall-clock read, and never stamped by this layer: that would turn
   * "when we last looked" into "when it last happened".
   */
  lastActivityAt?: number;
};

/**
 * What a run is connected to.
 *
 * The answer to "what in my workspace does this run touch?", and deliberately
 * nothing more. Every entry corresponds to a relationship the domain actually
 * stores - a work item's `runId`, an `AgentRunArtifactLink`, an `AgentRunLink`
 * - so there is no inference step anywhere in its construction.
 *
 * Tabs are reported as **ids**. This module does not import the tab store (for
 * the same reason `links.ts` does not), so resolving an id to a title is the
 * caller's job, exactly as it already is for the inspector.
 */
export type AgentRunImpact = {
  runId: string;
  workItems: WorkItemReference[];
  artifacts: ArtifactImpact[];
  /** Tabs the run used as input. */
  contextTabIds: string[];
  /** Tabs the run worked on. */
  producedTabIds: string[];
  /**
   * Every tab the run touched, in either role, deduplicated.
   *
   * Not the concatenation of the two lists above: one tab can be both context
   * and produced (the agent read a page and then edited it), and counting it
   * twice would overstate the run's reach.
   */
  affectedTabIds: string[];
};

/**
 * What one work item's *explicitly recorded* evidence resolves to.
 *
 * Read from stored `AgentWorkItemEvidence` rows and from nothing else. The
 * sets are empty when nothing was recorded, and they are emphatically not
 * the run's tabs and files filtered down - there is no filter, because there
 * is no derivation. See intelligence/work-item-evidence.ts.
 */
export type WorkItemEvidenceView = {
  workItemId: string;
  events: EventReference[];
  /** Tab ids. Resolving one to a title is the caller's job, as everywhere here. */
  tabIds: string[];
  artifacts: ArtifactImpact[];
  /** Total rows across all three kinds. Zero means nothing was recorded. */
  total: number;
};

/**
 * The relationships Phase 16 is willing to assert.
 *
 * A closed set, and every member maps one-to-one onto a row the domain
 * already stores. There is no `"related"`, no `"similar"`, and no kind whose
 * evidence is a resemblance.
 *
 * **`work-item -> artifact` is deliberately absent.** It is the relationship a
 * user would most like to have, and the domain does not record it: a work item
 * knows its run, and an artifact link knows its run, but nothing observes
 * which file was touched *for which task*. Joining them through the shared run
 * would produce a plausible edge for every (item, file) pair in the run - an
 * assertion nothing measured. So it is not emitted, and a test pins its
 * absence.
 */
export type AgentRelationshipKind =
  | "run-work-item"
  | "run-artifact"
  | "run-context-tab"
  | "run-produced-tab";

export const AGENT_RELATIONSHIP_KINDS: readonly AgentRelationshipKind[] = [
  "run-work-item",
  "run-artifact",
  "run-context-tab",
  "run-produced-tab",
] as const;

/**
 * One evidence-backed edge, from a run to something in the workspace.
 *
 * `id` is derived from the relationship itself rather than minted, the same
 * approach `agentRunLinkId` takes: recomputing the model after a poll must
 * produce the same ids, or every consumer keyed by them would churn.
 */
export type AgentObjectRelationship = {
  id: string;
  kind: AgentRelationshipKind;
  runId: string;
  /** A workItemId, artifactId or tabId, according to `kind`. */
  targetId: string;
  /** How the run touched the file. Present only for `run-artifact`. */
  role?: AgentRunArtifactRole;
};

/**
 * What is happening across one workspace.
 *
 * ## On "active"
 *
 * `byStatus` is the exhaustive, mutually exclusive partition - every run in
 * the workspace appears under exactly one of the six domain statuses.
 *
 * `activeRuns` is `working` union `waiting`, matching
 * `LIVE_AGENT_RUN_STATUSES`, which is the Phase 11 definition of "still live"
 * and the one Phase 14's canvas already uses. It therefore **overlaps**
 * `byStatus.waiting` on purpose, and is provided because "how much is live
 * right now" is a question asked far more often than it is convenient to
 * compute.
 *
 * What it is not: `blocked` is **terminal for a run** (Phase 11) and is not
 * live, even though `blocked` is *not* terminal for a work item (Phase 15).
 * The two vocabularies stay apart here exactly as they do in the domain.
 */
export type WorkspaceAgentActivity = {
  workspaceId: string;
  /** Exhaustive partition of the workspace's runs. Every run appears once. */
  byStatus: Record<AgentRunStatus, RunReference[]>;
  /** `working` union `waiting`. Overlaps `byStatus.waiting` by design. */
  activeRuns: RunReference[];
  activeWorkItems: WorkItemReference[];
  blockedWorkItems: WorkItemReference[];
  /** Completed items, most recently completed first. Bounded. */
  recentlyCompletedWorkItems: WorkItemReference[];
  /** Files touched anywhere in the workspace, most recently first. Bounded. */
  recentlyTouchedArtifacts: ArtifactReference[];
  /** Newest observed timestamp across the whole workspace, or undefined when empty. */
  lastActivityAt?: number;
};

/**
 * One run, reduced to what a card shows.
 *
 * The "what is happening?" view model. Purely a composition of the summary and
 * the run's resolved agent - it adds no fact of its own, and exists so that a
 * component does not have to join four models to render one row.
 */
export type AgentActivityCard = {
  runId: string;
  agentId: string;
  agentName: string;
  provider: string;
  /** The run's title, or its agent's name when it has none. Never a session id. */
  label: string;
  status: AgentRunStatus;
  activity?: string;
  /** The item that most wants attention. See `selectPrimaryWorkItem`. */
  primaryWorkItem?: WorkItemReference;
  progress?: AgentWorkItemProgress;
  workItems: WorkItemCounts;
  artifactCount: number;
  contextTabCount: number;
  producedTabCount: number;
  lastActivityAt?: number;
};

/** How many completed work items a workspace activity view carries. */
export const RECENT_COMPLETED_WORK_ITEM_LIMIT = 10;

/** How many recently touched files a workspace activity view carries. */
export const RECENT_ARTIFACT_LIMIT = 10;
