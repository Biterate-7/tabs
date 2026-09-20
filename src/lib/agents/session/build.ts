import { getAgentRunImpact } from "@/lib/agents/intelligence/impact";
import { toWorkItemReference } from "@/lib/agents/intelligence/references";
import { getAgentRunSummary } from "@/lib/agents/intelligence/run-summary";
import {
  getWorkItemEvidence,
  toEventReference,
} from "@/lib/agents/intelligence/work-item-evidence";
import type { AgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import type { ArtifactImpact } from "@/lib/agents/intelligence/types";
import type {
  AgentSessionResult,
  AgentSessionView,
  SessionArtifact,
  SessionWorkItem,
} from "./types";

/**
 * Assigns opaque, session-scoped keys to files.
 *
 * One assignment per built session, shared by the run context and by every
 * task's evidence, so the same file reads as the same file in both without
 * either carrying an artifact id. See the note on `SessionArtifact`: an
 * artifact id embeds the absolute project root, and this is what keeps it
 * from leaving the domain.
 *
 * Deterministic: keys are handed out in first-seen order over a traversal
 * that is itself deterministic, so rebuilding the same state yields the same
 * keys.
 */
function createArtifactKeys() {
  const keys = new Map<string, string>();
  return (impact: ArtifactImpact): SessionArtifact => {
    let key = keys.get(impact.artifact.artifactId);
    if (key === undefined) {
      key = `a${keys.size}`;
      keys.set(impact.artifact.artifactId, key);
    }
    return {
      key,
      relativePath: impact.artifact.relativePath,
      updatedAt: impact.artifact.updatedAt,
      roles: impact.roles,
    };
  };
}

/**
 * Resolves exactly one run into a durable record.
 *
 * ## Cost
 *
 * One run, plus its own evidence. Everything it reads is a map lookup on the
 * index: the run, its work items, its artifact links, its tab links, its
 * events, and one evidence bucket per work item. Nothing scans the domain,
 * and nothing is recomputed per rendered row - which is what keeps opening a
 * session from costing what enumerating history costs.
 *
 * ## What is reused rather than rebuilt
 *
 * `getAgentRunSummary` and `getAgentRunImpact` already answer "what does this
 * run amount to" and "what is it connected to". Re-deriving either here
 * would create a second answer free to disagree with the one the graph panel
 * and the world already show, so both are called rather than reimplemented.
 * This function's own contribution is the task-level layer they do not have.
 *
 * ## No clock
 *
 * `now` is not a parameter and `Date.now()` is not called. Every timestamp
 * in the result is one the domain stored. A session is a record of what
 * happened, and a record that consulted the current time could not be
 * rendered identically twice.
 */
export function buildAgentSession(index: AgentDomainIndex, runId: string): AgentSessionResult {
  const run = index.runsById.get(runId);
  if (!run) return { ok: false, reason: "run-not-found" };

  // Both resolve, because the run does - but they are the shared read models
  // and their signatures are optional, so the narrowing is kept rather than
  // asserted away.
  const summary = getAgentRunSummary(index, runId);
  const impact = getAgentRunImpact(index, runId);
  if (!summary || !impact) return { ok: false, reason: "run-not-found" };

  // The run's own files are keyed first, so a file's key is stable against
  // which tasks happen to reference it.
  const toSessionArtifact = createArtifactKeys();
  const runArtifacts = impact.artifacts.map(toSessionArtifact);

  const workItems: SessionWorkItem[] = (index.workItemsByRun.get(runId) ?? []).map((item) => {
    const evidence = getWorkItemEvidence(index, item.id);
    return {
      reference: toWorkItemReference(item),
      evidence: {
        workItemId: evidence.workItemId,
        events: evidence.events,
        tabIds: evidence.tabIds,
        artifacts: evidence.artifacts.map(toSessionArtifact),
        total: evidence.total,
      },
    };
  });

  const agent = index.agentsById.get(run.agentId);

  const session: AgentSessionView = {
    runId,
    // Missing agent is reported as missing. See the type notes - no
    // substitute identity is chosen here or anywhere downstream.
    agent: agent ? { agentId: agent.id, name: agent.name, provider: agent.provider } : null,
    workspaceId: run.workspaceId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary,
    workItems,
    runContext: {
      contextTabIds: impact.contextTabIds,
      producedTabIds: impact.producedTabIds,
      affectedTabIds: impact.affectedTabIds,
      artifacts: runArtifacts,
      events: (index.eventsByRun.get(runId) ?? []).map(toEventReference),
    },
  };

  if (run.title !== undefined) session.title = run.title;
  if (run.currentActivity !== undefined) session.currentActivity = run.currentActivity;
  if (run.endedAt !== undefined) session.endedAt = run.endedAt;

  return { ok: true, session };
}
