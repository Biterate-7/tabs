import { findRun } from "./runs";
import { agentFailure } from "./types";
import type { AgentFailure, AgentRunLink, AgentRunLinkRole, AgentState } from "./types";

/**
 * Links between an agent run and an existing Hubble tab.
 *
 * This module carries the workspace boundary. Hubble's workspaces are how a
 * user keeps unrelated work apart, and an agent run is the first thing in the
 * app with any reason to reach across one — so every link is checked, and a
 * cross-workspace link is refused rather than quietly repaired.
 */

/**
 * Deterministic, derived from the relationship itself — the same approach
 * dependencyId takes in src/lib/dependencies/relations.ts, and for the same
 * reason: re-linking after a reload must not mint a second row for what is
 * logically one relationship.
 *
 * Role is part of the identity, so one tab can be both `context` and
 * `produced` for the same run. That is a real situation (the agent read a
 * page and then edited it), not a duplicate.
 */
export function agentRunLinkId(runId: string, tabId: string, role: AgentRunLinkRole): string {
  return `arl-${runId}::${tabId}::${role}`;
}

export type AddRunLinkInput = {
  runId: string;
  tabId: string;
  role: AgentRunLinkRole;
  /**
   * The workspace the tab belongs to, supplied by the caller.
   *
   * Passed in rather than looked up because this domain does not import the
   * workspace store, and must not: inferring a tab's workspace from ambient
   * state is exactly the guess that would let a link land in the wrong place.
   * The caller knows which workspace it read the tab from, so it says so, and
   * this module holds it to it.
   */
  tabWorkspaceId: string;
};

export type AddRunLinkResult =
  | { ok: true; state: AgentState; link: AgentRunLink; created: boolean }
  | AgentFailure;

/**
 * Links a tab to a run, idempotently.
 *
 * Re-adding an existing link succeeds with `created: false` and leaves state
 * untouched, so a caller that cannot cheaply tell whether it has already
 * linked something does not have to care. A link whose tab lives in a
 * different workspace than the run is refused with `cross-workspace`.
 */
export function addRunLink(
  state: AgentState,
  input: AddRunLinkInput,
  now: number
): AddRunLinkResult {
  const tabId = input.tabId.trim();
  const tabWorkspaceId = input.tabWorkspaceId.trim();
  if (!tabId || !tabWorkspaceId) return agentFailure("invalid-input");

  const run = findRun(state, input.runId);
  if (!run) return agentFailure("run-not-found");
  if (run.workspaceId !== tabWorkspaceId) return agentFailure("cross-workspace");

  const id = agentRunLinkId(run.id, tabId, input.role);
  const existing = state.links.find((link) => link.id === id);
  if (existing) return { ok: true, state, link: existing, created: false };

  const link: AgentRunLink = {
    id,
    runId: run.id,
    tabId,
    role: input.role,
    createdAt: now,
  };

  return { ok: true, state: { ...state, links: [...state.links, link] }, link, created: true };
}

export type RemoveRunLinkResult = { ok: true; state: AgentState };

/** Removing a link that is not there is a success, not an error — the caller's intent is already satisfied. */
export function removeRunLink(state: AgentState, linkId: string): RemoveRunLinkResult {
  return { ok: true, state: { ...state, links: state.links.filter((link) => link.id !== linkId) } };
}

/**
 * Drops every link belonging to a run.
 *
 * deleteRun already does this as part of its cascade; this exists for the
 * narrower "unlink everything but keep the run" case.
 */
export function removeLinksForRun(state: AgentState, runId: string): RemoveRunLinkResult {
  return { ok: true, state: { ...state, links: state.links.filter((link) => link.runId !== runId) } };
}

/**
 * Drops links pointing at tabs that no longer exist.
 *
 * The mirror of pruneDependencyState: tabs are deleted by parts of the app
 * that know nothing about agents, so a link can outlive its tab. Called with
 * the set of live tab ids at read time rather than reactively, so a deletion
 * is reflected on the very next read.
 *
 * Tab evidence goes with the link. A row saying "this task used this tab"
 * is only meaningful while the run-level link it refines exists, and keeping
 * it would leave a task pointing at a tab its run is no longer recorded as
 * having touched.
 */
export function pruneRunLinks(state: AgentState, validTabIds: Set<string>): AgentState {
  const kept = state.links.filter((link) => validTabIds.has(link.tabId));
  const keptEvidence = state.workItemEvidence.filter(
    (row) => row.kind !== "tab" || validTabIds.has(row.targetId)
  );
  if (
    kept.length === state.links.length &&
    keptEvidence.length === state.workItemEvidence.length
  ) {
    return state;
  }
  return { ...state, links: kept, workItemEvidence: keptEvidence };
}
