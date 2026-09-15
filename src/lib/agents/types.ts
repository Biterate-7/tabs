/**
 * The provider-agnostic agent domain.
 *
 * TabDump's job here is to *represent* work done by an external coding agent,
 * never to perform it. The shape is deliberately four small entities:
 *
 *     Agent                 a persistent identity ("Claude Code")
 *       |-- AgentRun        one session of that identity, inside a workspace
 *             |-- AgentRunLink   this run touched this tab
 *             |-- AgentEvent     a bounded, safe activity log
 *
 * Nothing in this directory knows what a provider is beyond a string. The
 * Claude-Code-specific reader/parser that a later phase adds lives outside it
 * and reaches the domain only through the observation seam in ./adapter.ts.
 * That separation is the point: the domain must never grow a field because
 * one provider happens to expose it.
 */

/**
 * Where a run is in its life.
 *
 * `working` and `waiting` are the only live states — the run is ongoing and
 * may still change. The other four are terminal: the run is over, and how it
 * ended is recorded rather than re-derived.
 *
 * `blocked` is terminal in this phase. A run that needs something it cannot
 * get has stopped; if a later phase wants "paused, may resume", that is a new
 * live state, not a loosening of this one.
 */
export type AgentRunStatus =
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  "working",
  "waiting",
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const;

/** Statuses a run never leaves through ordinary operations. */
export const TERMINAL_AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const;

/** The two live statuses — the complement of TERMINAL_AGENT_RUN_STATUSES. */
export const LIVE_AGENT_RUN_STATUSES: readonly AgentRunStatus[] = ["working", "waiting"] as const;

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === "string" && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return (TERMINAL_AGENT_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * A persistent agent identity, scoped to the account (not to a workspace).
 *
 * One Agent has many AgentRuns. Minting an Agent per session would be the
 * central modelling mistake available here: it would make "how much has this
 * agent done in this workspace" unanswerable, and would grow the registry
 * without bound.
 */
export type Agent = {
  id: string;
  /** Opaque provider key, e.g. "claude-code". The domain never interprets it. */
  provider: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * One execution/session of an Agent, inside exactly one workspace.
 *
 * `workspaceId` is not advisory. Every relationship this run takes part in is
 * checked against it (see ./links.ts), because the workspace is TabDump's
 * existing organisation boundary and an agent run must not be the thing that
 * quietly punches through it.
 */
export type AgentRun = {
  id: string;
  agentId: string;
  workspaceId: string;
  /**
   * The provider's own identity for this session, opaque here.
   *
   * A later phase sets this to a provider session id so that observing the
   * same session repeatedly updates one run instead of minting a new one.
   * This phase stores and matches it; it never parses it.
   */
  externalId?: string;
  status: AgentRunStatus;
  title?: string;
  /** Short human-readable summary of what the run is doing right now. */
  currentActivity?: string;
  createdAt: number;
  updatedAt: number;
  /** Set exactly when the run reaches a terminal status; absent while live. */
  endedAt?: number;
};

/**
 * How a run relates to a tab.
 *
 * Intentionally two values. This is not a general edge type — TabDump already
 * has those (ManualConnection, TabDependency) and does not need a third
 * spelling of "related".
 */
export type AgentRunLinkRole = "context" | "produced";

export const AGENT_RUN_LINK_ROLES: readonly AgentRunLinkRole[] = ["context", "produced"] as const;

export function isAgentRunLinkRole(value: unknown): value is AgentRunLinkRole {
  return typeof value === "string" && (AGENT_RUN_LINK_ROLES as readonly string[]).includes(value);
}

/** A run touched a tab: `context` = it was input, `produced` = the run worked on it. */
export type AgentRunLink = {
  id: string;
  runId: string;
  tabId: string;
  role: AgentRunLinkRole;
  createdAt: number;
};

/**
 * What an event records.
 *
 * A closed set, on purpose. An open string would become the place provider
 * detail leaks in one `kind` at a time.
 */
export type AgentEventKind = "started" | "status" | "activity" | "link" | "ended";

export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = [
  "started",
  "status",
  "activity",
  "link",
  "ended",
] as const;

export function isAgentEventKind(value: unknown): value is AgentEventKind {
  return typeof value === "string" && (AGENT_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * One entry in a run's activity log.
 *
 * `summary` is a short, already-safe, human-readable line — "Edited
 * graph-canvas.tsx", not a shell command and not a model's reasoning. The
 * domain has no field for a raw provider payload and must not grow one:
 * whatever a provider knows is reduced to a summary at the adapter boundary,
 * before it ever reaches here. See ./adapter.ts.
 */
export type AgentEvent = {
  id: string;
  runId: string;
  timestamp: number;
  kind: AgentEventKind;
  summary: string;
  /**
   * The provider's stable id for the source record this event came from, if
   * it has one. Used only to avoid appending the same observation twice;
   * never parsed.
   */
  sourceId?: string;
};

/**
 * Hard cap on a run's event history.
 *
 * An agent session can emit events for hours. Without a cap this array is the
 * one structure in the domain that grows without bound, and it is persisted
 * to localStorage, where growing without bound eventually throws a quota
 * error that would take the rest of the user's state down with it. Newest
 * events win — the recent ones are what any UI shows.
 */
export const MAX_EVENTS_PER_RUN = 200;

/**
 * Cap on a single summary, in characters.
 *
 * Bounds the *width* of the log as MAX_EVENTS_PER_RUN bounds its length, and
 * gives a second, structural reason a provider cannot smuggle a large payload
 * through the `summary` field.
 */
export const MAX_SUMMARY_LENGTH = 200;

/**
 * What kind of thing a run worked on.
 *
 * One value today, and the set grows only when a provider can actually
 * observe something new — not in anticipation. An open `kind` string would
 * turn this into a general-purpose graph, which is precisely what the model
 * is meant not to be.
 */
export type WorkArtifactKind = "file";

export const WORK_ARTIFACT_KINDS: readonly WorkArtifactKind[] = ["file"] as const;

export function isWorkArtifactKind(value: unknown): value is WorkArtifactKind {
  return typeof value === "string" && (WORK_ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * A project file an agent run worked on.
 *
 * Identity is (workspaceId, projectPath, relativePath), which is why
 * `relativePath` and not a filename: `src/lib/foo.ts` in one project and the
 * same path in another are different files, and a workspace may hold several
 * projects. See ./paths.ts for how a path becomes project-relative, and note
 * what is absent — there is no field here for contents, a diff, a size, a
 * hash or a revision. TabDump records *that* a run touched a file, never what
 * the file says.
 */
export type WorkArtifact = {
  id: string;
  workspaceId: string;
  /** The project root this file belongs to, as the provider reported it. */
  projectPath: string;
  /** Path within the project, forward-slashed. Never absolute, never escaping the root. */
  relativePath: string;
  kind: WorkArtifactKind;
  createdAt: number;
  /** When this artifact was last observed being worked on. */
  updatedAt: number;
};

/**
 * How a run interacted with a file.
 *
 * Four values, closed. `created` and `deleted` exist for providers that can
 * actually distinguish them; see the Claude Code notes in
 * docs/phase-13-agent-work-artifacts.md for why that provider currently
 * reports neither.
 */
export type AgentRunArtifactRole = "inspected" | "edited" | "created" | "deleted";

export const AGENT_RUN_ARTIFACT_ROLES: readonly AgentRunArtifactRole[] = [
  "inspected",
  "edited",
  "created",
  "deleted",
] as const;

export function isAgentRunArtifactRole(value: unknown): value is AgentRunArtifactRole {
  return typeof value === "string" &&
    (AGENT_RUN_ARTIFACT_ROLES as readonly string[]).includes(value);
}

/**
 * "This run interacted with this file, this way."
 *
 * Distinct from AgentRunLink, which connects a run to a *tab*. A tab is a
 * human context surface; an artifact is a work target. Collapsing them into
 * one relationship would lose the distinction that makes either useful.
 */
export type AgentRunArtifactLink = {
  id: string;
  runId: string;
  artifactId: string;
  role: AgentRunArtifactRole;
  createdAt: number;
};

/**
 * Where a unit of work is in its life.
 *
 * Deliberately NOT the same vocabulary as AgentRunStatus, and the difference
 * is the point: `blocked` here is *not* terminal. A run that blocked has
 * stopped — the session is over and a new one will be needed. A work item
 * that blocked is waiting on something, and the very next observation may
 * unblock it. Collapsing the two vocabularies would force one of those two
 * truths to be wrong.
 *
 * `pending` has no run-level equivalent at all: a run exists because a
 * session started, whereas a work item can be known about before anything
 * has been done toward it.
 */
export type AgentWorkItemStatus = "pending" | "active" | "blocked" | "completed" | "cancelled";

export const AGENT_WORK_ITEM_STATUSES: readonly AgentWorkItemStatus[] = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
] as const;

/**
 * The two statuses a work item never leaves.
 *
 * `blocked` is absent, and that absence is the whole reason this constant is
 * separate from TERMINAL_AGENT_RUN_STATUSES rather than shared with it.
 */
export const TERMINAL_AGENT_WORK_ITEM_STATUSES: readonly AgentWorkItemStatus[] = [
  "completed",
  "cancelled",
] as const;

export function isAgentWorkItemStatus(value: unknown): value is AgentWorkItemStatus {
  return (
    typeof value === "string" && (AGENT_WORK_ITEM_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalWorkItemStatus(status: AgentWorkItemStatus): boolean {
  return (TERMINAL_AGENT_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

/**
 * Explicit, structured progress through one work item.
 *
 * Exists only for providers that actually count something. It is never
 * derived from event volume, tool-call counts, elapsed time, or how far
 * through a transcript a poll has read — all of which would produce a number
 * that looks measured and is invented. A provider that cannot count leaves
 * this undefined, and every consumer omits the indicator rather than
 * rendering a fabricated ratio. See docs/phase-15-agent-work-tracking.md.
 */
export type AgentWorkItemProgress = {
  completed: number;
  total: number;
};

/**
 * A meaningful unit of work belonging to one agent run.
 *
 * "Implement authentication", "Investigate failing test" — a project-
 * management object, not a command. Nothing here is executable and nothing
 * downstream will execute it: there is no field for a prompt, an argument
 * list, a command or a script, and the absence is structural rather than
 * enforced by convention.
 *
 * A run may have many; a work item belongs to exactly one run and therefore
 * to exactly one workspace. `workspaceId` is denormalised from the run rather
 * than looked up, for the same reason AgentRun carries one: every
 * relationship is checked against it, and a selector that had to join through
 * the run to know which workspace an item belongs to would be one join away
 * from leaking across the boundary.
 */
export type AgentWorkItem = {
  id: string;
  workspaceId: string;
  runId: string;
  /**
   * The provider's own identity for this item, opaque here.
   *
   * What makes repeated observation idempotent: the same task seen on three
   * consecutive polls updates one work item instead of minting three. Scoped
   * per run, never parsed, and never rendered.
   */
  externalId?: string;
  title: string;
  summary?: string;
  status: AgentWorkItemStatus;
  createdAt: number;
  updatedAt: number;
  /** Stamped the first time the item becomes `active`, and never rewritten after. */
  startedAt?: number;
  /** Stamped when the item reaches `completed` or `cancelled`. Absent otherwise. */
  completedAt?: number;
  progress?: AgentWorkItemProgress;
};

/**
 * Cap on a work item title, in characters.
 *
 * Titles come from provider-authored prose, so they are bounded for the same
 * reason summaries are: to keep one observation from turning a list row into
 * a wall of text, and to deny a payload a wide channel to travel through.
 */
export const MAX_WORK_ITEM_TITLE_LENGTH = 120;

/** Cap on a work item summary. Wider than a title, still bounded. */
export const MAX_WORK_ITEM_SUMMARY_LENGTH = 400;

/**
 * Hard cap on work items per run.
 *
 * The same bounded-growth argument as MAX_EVENTS_PER_RUN: this array is
 * persisted to localStorage, and a provider that emitted an item per tool
 * call would otherwise grow it until a quota error took the user's whole
 * state down. Unlike events, the OLDEST items win here — a plan's first
 * tasks are its structure, and dropping them to make room for later ones
 * would leave a list that starts in the middle.
 */
export const MAX_WORK_ITEMS_PER_RUN = 100;

/**
 * Normalises a work item title: collapsed whitespace, trimmed, truncated.
 *
 * Same treatment as normalizeSummary and for the same reasons, with a
 * narrower bound.
 */
export function normalizeWorkItemTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_WORK_ITEM_TITLE_LENGTH
    ? `${collapsed.slice(0, MAX_WORK_ITEM_TITLE_LENGTH - 1)}…`
    : collapsed;
}

/** As normalizeWorkItemTitle, at summary width. */
export function normalizeWorkItemSummary(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_WORK_ITEM_SUMMARY_LENGTH
    ? `${collapsed.slice(0, MAX_WORK_ITEM_SUMMARY_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Validates explicit progress, returning undefined for anything unusable.
 *
 * Refuses a zero `total` (a ratio out of nothing is not progress), negative
 * or non-integer values, and `completed > total`. Returning undefined rather
 * than clamping is deliberate: a provider that sent 12/10 has a bug, and
 * silently rendering 10/10 would turn its bug into a false claim that the
 * work is finished.
 */
export function normalizeWorkItemProgress(value: unknown): AgentWorkItemProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { completed, total } = value as Record<string, unknown>;

  if (typeof completed !== "number" || !Number.isInteger(completed) || completed < 0) {
    return undefined;
  }
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return undefined;
  if (completed > total) return undefined;

  return { completed, total };
}

export const AGENT_STATE_VERSION = 1;

/**
 * The whole persisted domain. Flat arrays, matching how collections and
 * dependencies are stored — relationships are by id, resolved in selectors.
 *
 * `artifacts` and `artifactLinks` were added after the first three were in
 * use. They are additive: state written before they existed simply has
 * neither key, and loading defaults both to empty rather than rejecting the
 * record, so no existing agent history is invalidated by the upgrade.
 */
export type AgentState = {
  version: typeof AGENT_STATE_VERSION;
  agents: Agent[];
  runs: AgentRun[];
  links: AgentRunLink[];
  events: AgentEvent[];
  artifacts: WorkArtifact[];
  artifactLinks: AgentRunArtifactLink[];
  /**
   * Added after the six above were in use, and additive in exactly the way
   * `artifacts` was: state written before work items existed simply has no
   * such key, and loading defaults it to empty rather than rejecting the
   * record. No existing agent history is invalidated by the upgrade, and no
   * version bump is needed to read it.
   */
  workItems: AgentWorkItem[];
};

/**
 * Why an operation was refused.
 *
 * Operations that can fail return one of these instead of silently doing
 * nothing, because "rejected a cross-workspace link" and "that link already
 * existed" are different outcomes and a caller needs to tell them apart.
 */
export type AgentFailureReason =
  | "invalid-input"
  | "agent-not-found"
  | "agent-has-runs"
  | "run-not-found"
  | "invalid-transition"
  | "terminal-run"
  | "cross-workspace"
  | "artifact-not-found"
  | "invalid-path"
  | "work-item-not-found";

export type AgentFailure = { ok: false; reason: AgentFailureReason };

export function agentFailure(reason: AgentFailureReason): AgentFailure {
  return { ok: false, reason };
}

/** An empty domain. The one place the initial shape is spelled out. */
export function emptyAgentState(): AgentState {
  return {
    version: AGENT_STATE_VERSION,
    agents: [],
    runs: [],
    links: [],
    events: [],
    artifacts: [],
    artifactLinks: [],
    workItems: [],
  };
}

/**
 * Normalises a summary into something safe to store: collapsed whitespace,
 * trimmed, and truncated to MAX_SUMMARY_LENGTH.
 *
 * Whitespace collapsing matters more than it looks — a provider summary
 * carrying embedded newlines would otherwise turn a one-line log into a wall
 * of text in every consumer that renders it.
 */
export function normalizeSummary(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SUMMARY_LENGTH
    ? `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : collapsed;
}
