import type {
  AgentRunSummary,
  EventReference,
  WorkItemReference,
} from "@/lib/agents/intelligence/types";
import type { AgentRunArtifactRole, AgentRunStatus } from "@/lib/agents/types";

/**
 * A file in a session, with an opaque per-session key.
 *
 * ## Why `key` is not `artifactId`
 *
 * A `WorkArtifact`'s id is `wa-<workspace>::<normalised project path>::<relative
 * path>` - it *embeds the absolute local project root*. The intelligence
 * layer drops the `projectPath` field from `ArtifactReference` but keeps the
 * id, so the path survives inside it. Anything that serialised such a
 * reference, put it in a React key, or copied it into an address would carry
 * the user's local directory structure with it.
 *
 * So the Session View does not carry artifact ids at all. `key` is assigned
 * per built session - `a0`, `a1`, ... in a deterministic order - which is
 * unique within the session, stable across rebuilds of the same state, and
 * reveals nothing. Task evidence and run context share one assignment, so
 * the same file has the same key in both and the two can be cross-referenced
 * without an id.
 *
 * It is deliberately not a hash of the id either: a hash of a short, guessable
 * string is not a one-way function in any useful sense here.
 */
export type SessionArtifact = {
  /** Opaque, session-scoped. Never persisted, never an address component. */
  key: string;
  /** Project-relative, forward-slashed. Safe to render. Never absolute. */
  relativePath: string;
  updatedAt: number;
  /** Every role the run holds on this file. `inspected` is not a result. */
  roles: AgentRunArtifactRole[];
};

/**
 * One work item's explicitly recorded evidence, with session-safe files.
 *
 * Mirrors `WorkItemEvidenceView` but substitutes `SessionArtifact` for
 * `ArtifactImpact`, for the reason above.
 */
export type SessionWorkItemEvidence = {
  workItemId: string;
  events: EventReference[];
  tabIds: string[];
  artifacts: SessionArtifact[];
  /** Total recorded rows. Zero means nothing was recorded for this task. */
  total: number;
};

/**
 * One run, as a durable record.
 *
 * ## What makes this different from the live canvas
 *
 * The canvas is a presentation surface and answers "who is working now?".
 * It is allowed to use a recency window and to draw only some runs. This
 * answers "what did this run do?", and nothing in it may depend on any of
 * that: no recency window is consulted anywhere in its construction, no
 * spatial placement is read, and whether the run is live changes only the
 * value of `status`.
 *
 * A run outside the canvas's six-hour window resolves here exactly as a live
 * one does, which is the whole reason the type exists.
 *
 * ## The task/run separation
 *
 * `workItems[].evidence` holds what was explicitly recorded for that task.
 * `runContext` holds what the *run* is related to. They are separate fields
 * rather than one merged list because they are different claims, and a
 * surface that showed run-level tabs under a selected task would be
 * asserting an attribution nothing observed. Neither is derived from the
 * other, and the run context is not the task evidence subtracted from
 * anything - it is simply the run's own relationships.
 */
export type AgentSessionView = {
  runId: string;
  /**
   * The run's agent, when it still resolves.
   *
   * `null` when it does not. No substitute is chosen and no placeholder
   * identity is minted: attributing a run to the wrong agent is worse than
   * saying the agent is unknown, and every consumer renders the absence.
   */
  agent: SessionAgent | null;
  /** The run's own workspace. Kept so a caller can name it and return to it. */
  workspaceId: string;
  /** The domain's stored status, copied. Never recomputed from evidence. */
  status: AgentRunStatus;
  /** Absent when the run recorded none. Callers show an honest fallback line. */
  title?: string;
  currentActivity?: string;
  createdAt: number;
  updatedAt: number;
  /** Present exactly when the domain recorded an ending. Never inferred. */
  endedAt?: number;
  /** The existing evidence-based summary, reused rather than recomputed here. */
  summary: AgentRunSummary;
  /** Every work item of the run, in plan order. Completed items included. */
  workItems: SessionWorkItem[];
  /** The run's own relationships. Explicitly *not* evidence for any one task. */
  runContext: SessionRunContext;
};

/** A run's agent, narrowed to what a header shows. Never an external id. */
export type SessionAgent = {
  agentId: string;
  name: string;
  /** The opaque provider key, used only to pick a visual identity. */
  provider: string;
};

/** One work item plus the evidence explicitly recorded for it. */
export type SessionWorkItem = {
  reference: WorkItemReference;
  evidence: SessionWorkItemEvidence;
};

/**
 * What the run as a whole touched.
 *
 * Presented under its own heading so a user can tell "the run opened this
 * tab" from "this task used this tab". The two can legitimately differ in
 * both directions: a run holds tabs no task claimed, and a task's evidence
 * is always a subset of what its run touched because the write path refuses
 * any row whose target the run does not already hold.
 */
export type SessionRunContext = {
  contextTabIds: string[];
  producedTabIds: string[];
  /**
   * Every tab the run touched, in either role, deduplicated.
   *
   * Not the concatenation of the two above: one tab can be both context and
   * produced (the agent read a page and then worked on it), and listing it
   * twice would overstate the run's reach. Carried here rather than
   * recomputed in the view because `AgentRunImpact` already derives it.
   */
  affectedTabIds: string[];
  artifacts: SessionArtifact[];
  /** The run's whole timeline, oldest first. Bounded by the domain at 200. */
  events: EventReference[];
};

/** A resolved session, or why it could not be resolved. */
export type AgentSessionResult =
  | { ok: true; session: AgentSessionView }
  | { ok: false; reason: "run-not-found" };

export type { WorkItemReference };
