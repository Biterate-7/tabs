import type { AgentRunStatus } from "@/lib/agents/types";

/**
 * One row in Agent History.
 *
 * Every field is either stored by the domain or counted from it. There is no
 * generated description, no inferred intent and no score: a row says who,
 * where, what status, what title was recorded, how much was touched and
 * when - and where the domain recorded nothing, the field is `null` so the
 * UI can say so rather than fill it in.
 *
 * `title: null` is the one worth calling out. A run with no recorded title
 * gets an honest fallback line at the point of rendering, never a
 * manufactured one here, because a title composed from a provider name and a
 * timestamp would be indistinguishable from one the agent actually wrote.
 */
export type AgentHistoryEntry = {
  runId: string;
  agentId: string;
  /** `null` when the agent record is gone. No substitute is chosen. */
  agentName: string | null;
  /** The opaque provider key, for the visual identity only. `null` with the agent. */
  provider: string | null;
  workspaceId: string;
  /** `null` when the caller did not name this workspace, or it no longer exists. */
  workspaceName: string | null;
  status: AgentRunStatus;
  /** `null` when the run recorded none. Never a generated stand-in. */
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** Present exactly when the domain recorded an ending. */
  endedAt?: number;
  /** Newest stored evidence timestamp. Never a wall-clock read. */
  lastActivityAt?: number;
  workItemCount: number;
  artifactCount: number;
  /** Distinct tabs in either role, matching how the run summary counts them. */
  tabCount: number;
  eventCount: number;
};

/**
 * The whole filter vocabulary, and deliberately all of it.
 *
 * Three exact-match fields. No text query, no date range, no sort order, no
 * grouping mode: history exists to find a session, and each addition here
 * would move it toward the analytics dashboard the brief rules out. An unset
 * field matches everything.
 */
export type AgentHistoryFilter = {
  agentId?: string;
  workspaceId?: string;
  status?: AgentRunStatus;
};

/** A facet value plus how many runs carry it. Used to build filter controls. */
export type AgentHistoryAgentFacet = {
  agentId: string;
  name: string | null;
  runCount: number;
};

export type AgentHistoryWorkspaceFacet = {
  workspaceId: string;
  name: string | null;
  runCount: number;
};

/**
 * The history list, plus what can be filtered on.
 *
 * `totalCount` is the unfiltered size, so a view can say "3 of 11" without a
 * second build. The facets are also unfiltered - a control that removed its
 * own options as they were selected would strand the user inside a filter.
 */
export type AgentHistoryView = {
  entries: AgentHistoryEntry[];
  totalCount: number;
  agents: AgentHistoryAgentFacet[];
  workspaces: AgentHistoryWorkspaceFacet[];
};
