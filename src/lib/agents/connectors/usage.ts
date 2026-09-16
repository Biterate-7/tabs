import { isTerminalRunStatus } from "@/lib/agents/types";
import type { AgentState } from "@/lib/agents/types";
import type { AgentProviderId } from "./types";

/**
 * How much a provider has actually produced.
 *
 * Every number here is counted from recorded state — runs that exist, files
 * that were linked, work items that were observed. Nothing is estimated,
 * extrapolated or animated, which is the whole reason a connector card can
 * show numbers at all: a card that displayed activity a connector had not
 * reported would be the fake-liveness failure this phase exists to prevent.
 *
 * Provider-scoped rather than workspace-scoped, because that is the question
 * a connector raises — "what has Claude Code done for me", across everywhere
 * it has worked. The existing workspace-scoped selectors answer the other
 * question and are untouched.
 *
 * Pure, and independent of React: the settings UI and any test can call it
 * with a state snapshot.
 */
export type ProviderUsage = {
  /** Agent identities registered for this provider. Normally one. */
  agents: number;
  activeRuns: number;
  completedRuns: number;
  totalRuns: number;
  /** Distinct files this provider's runs have touched. */
  artifacts: number;
  workItems: number;
  /** The newest `updatedAt` across this provider's runs, or undefined if it has none. */
  lastActivityAt?: number;
};

export const EMPTY_PROVIDER_USAGE: ProviderUsage = {
  agents: 0,
  activeRuns: 0,
  completedRuns: 0,
  totalRuns: 0,
  artifacts: 0,
  workItems: 0,
};

export function summarizeProviderUsage(
  state: AgentState,
  provider: AgentProviderId
): ProviderUsage {
  const agentIds = new Set(
    state.agents.filter((agent) => agent.provider === provider).map((agent) => agent.id)
  );
  if (agentIds.size === 0) return EMPTY_PROVIDER_USAGE;

  const runs = state.runs.filter((run) => agentIds.has(run.agentId));
  if (runs.length === 0) return { ...EMPTY_PROVIDER_USAGE, agents: agentIds.size };

  const runIds = new Set(runs.map((run) => run.id));

  let activeRuns = 0;
  let completedRuns = 0;
  let lastActivityAt = 0;

  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) completedRuns += 1;
    else activeRuns += 1;
    if (run.updatedAt > lastActivityAt) lastActivityAt = run.updatedAt;
  }

  // Distinct artifacts, not links: one file edited eight times by a run is one
  // file, and counting the links would inflate the number until it read as a
  // measure of activity rather than of work product.
  const artifacts = new Set(
    state.artifactLinks.filter((link) => runIds.has(link.runId)).map((link) => link.artifactId)
  );

  const workItems = state.workItems.filter((item) => runIds.has(item.runId)).length;

  return {
    agents: agentIds.size,
    activeRuns,
    completedRuns,
    totalRuns: runs.length,
    artifacts: artifacts.size,
    workItems,
    ...(lastActivityAt > 0 ? { lastActivityAt } : {}),
  };
}
