import { createId } from "@/lib/id";
import { agentFailure } from "./types";
import type { Agent, AgentFailure, AgentState } from "./types";

/**
 * Agent identities: create, read, update, delete.
 *
 * Every function here is a pure reducer over AgentState — it reads no clock
 * and touches no storage, so the caller injects `now` (see
 * src/lib/reducer-purity.test.ts for why that rule exists). Operations that
 * can be refused return a discriminated result rather than silently returning
 * the input state, because the caller needs to tell "already done" from
 * "not allowed".
 */

export type CreateAgentInput = {
  provider: string;
  name: string;
};

export type CreateAgentResult = { ok: true; state: AgentState; agent: Agent } | AgentFailure;

/**
 * Mints a new agent identity.
 *
 * Deliberately permits two agents with the same provider: a user may well
 * want "Claude Code (work)" and "Claude Code (personal)" as separate
 * identities, and the domain has no basis for calling that a mistake.
 * Callers that want one-per-provider should use findAgentByProvider first —
 * that is a policy for the caller, not an invariant of the registry.
 */
export function createAgent(
  state: AgentState,
  input: CreateAgentInput,
  now: number
): CreateAgentResult {
  const provider = input.provider.trim();
  const name = input.name.trim();
  if (!provider || !name) return agentFailure("invalid-input");

  const agent: Agent = {
    id: createId(),
    provider,
    name,
    createdAt: now,
    updatedAt: now,
  };

  return { ok: true, state: { ...state, agents: [...state.agents, agent] }, agent };
}

export function findAgent(state: AgentState, agentId: string): Agent | undefined {
  return state.agents.find((agent) => agent.id === agentId);
}

/**
 * The first agent registered for a provider.
 *
 * This is how a provider-level adapter finds "its" identity without minting a
 * second one on every observation.
 */
export function findAgentByProvider(state: AgentState, provider: string): Agent | undefined {
  return state.agents.find((agent) => agent.provider === provider);
}

export function listAgents(state: AgentState): Agent[] {
  return state.agents;
}

export type UpdateAgentPatch = {
  name?: string;
};

export type UpdateAgentResult = { ok: true; state: AgentState; agent: Agent } | AgentFailure;

/**
 * Renames an agent.
 *
 * `provider` is intentionally not patchable: it is the key an adapter
 * resolves its identity by, and letting it change would silently orphan
 * every run the adapter had been updating.
 */
export function updateAgent(
  state: AgentState,
  agentId: string,
  patch: UpdateAgentPatch,
  now: number
): UpdateAgentResult {
  const existing = findAgent(state, agentId);
  if (!existing) return agentFailure("agent-not-found");

  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) return agentFailure("invalid-input");
  if (name === undefined || name === existing.name) {
    return { ok: true, state, agent: existing };
  }

  const agent: Agent = { ...existing, name, updatedAt: now };
  return {
    ok: true,
    state: { ...state, agents: state.agents.map((a) => (a.id === agentId ? agent : a)) },
    agent,
  };
}

export type DeleteAgentResult = { ok: true; state: AgentState } | AgentFailure;

/**
 * Removes an agent identity, but only while nothing depends on it.
 *
 * Refusing when runs exist is the safe default: the alternative is either
 * orphaned runs pointing at an agent that is gone, or a silent cascade that
 * destroys a work history the user never asked to delete. Callers that really
 * do mean "and everything it did" reach for deleteAgentAndRuns, which says so
 * at the call site.
 */
export function deleteAgent(state: AgentState, agentId: string): DeleteAgentResult {
  if (!findAgent(state, agentId)) return agentFailure("agent-not-found");
  if (state.runs.some((run) => run.agentId === agentId)) return agentFailure("agent-has-runs");

  return { ok: true, state: { ...state, agents: state.agents.filter((a) => a.id !== agentId) } };
}

/**
 * Removes an agent and every run, link and event beneath it.
 *
 * The destructive counterpart to deleteAgent. Separate rather than a boolean
 * flag so that the intent is unmistakable in the calling code.
 */
export function deleteAgentAndRuns(state: AgentState, agentId: string): DeleteAgentResult {
  if (!findAgent(state, agentId)) return agentFailure("agent-not-found");

  const doomedRunIds = new Set(
    state.runs.filter((run) => run.agentId === agentId).map((run) => run.id)
  );

  return {
    ok: true,
    state: {
      ...state,
      agents: state.agents.filter((a) => a.id !== agentId),
      runs: state.runs.filter((run) => run.agentId !== agentId),
      links: state.links.filter((link) => !doomedRunIds.has(link.runId)),
      events: state.events.filter((event) => !doomedRunIds.has(event.runId)),
      // Artifact links go with their runs; the artifacts themselves may still
      // be referenced by another agent's runs, so they are left for
      // pruneOrphanedArtifacts to collect if nothing reaches them.
      artifactLinks: state.artifactLinks.filter((link) => !doomedRunIds.has(link.runId)),
      // Work items belong to exactly one run, so they go unconditionally —
      // there is no shared-ownership case of the kind artifacts have.
      workItems: state.workItems.filter((item) => !doomedRunIds.has(item.runId)),
    },
  };
}
