import { toArtifactReference } from "./references";
import type { AgentDomainIndex } from "./domain-index";
import type { ArtifactImpact, EventReference, WorkItemEvidenceView } from "./types";
import type { AgentEvent } from "@/lib/agents/types";

/**
 * Task-level evidence: the read side.
 *
 * The counterpart to lib/agents/work-item-evidence.ts, and it inherits that
 * module's central refusal. Nothing here derives an association. Every value
 * returned corresponds to a stored `AgentWorkItemEvidence` row, so a work
 * item with no rows returns empty sets rather than its run's tabs and files -
 * which is what a join through the shared run would have produced, and what
 * intelligence/types.ts documents as the assertion this layer will not make.
 *
 * ## Disjointness
 *
 * Two work items in one run return overlapping evidence only when two
 * explicit rows say so. That is not enforced here by subtraction - it falls
 * out of reading stored rows and nothing else - which is the property that
 * makes the Session View's task/run separation trustworthy rather than
 * cosmetic.
 */

/** An event, narrowed. Drops `sourceId`, the provider's own record id. */
export function toEventReference(event: AgentEvent): EventReference {
  return {
    eventId: event.id,
    kind: event.kind,
    summary: event.summary,
    timestamp: event.timestamp,
  };
}

/**
 * What one work item's stored evidence resolves to.
 *
 * Costs one map lookup plus the size of the result. An unknown work item and
 * one with no evidence are reported identically - as empty - because the
 * Session View renders the same honest line for both, and distinguishing
 * them here would only invite a caller to render "this task does not exist"
 * where it means "nothing was recorded".
 */
export function getWorkItemEvidence(
  index: AgentDomainIndex,
  workItemId: string
): WorkItemEvidenceView {
  const rows = index.evidenceByWorkItem.get(workItemId) ?? [];

  const events: EventReference[] = [];
  const tabIds: string[] = [];
  const artifacts: ArtifactImpact[] = [];

  for (const row of rows) {
    if (row.kind === "event") {
      const event = index.eventsById.get(row.targetId);
      if (event) events.push(toEventReference(event));
      continue;
    }

    if (row.kind === "tab") {
      tabIds.push(row.targetId);
      continue;
    }

    const artifact = index.artifactsById.get(row.targetId);
    if (!artifact) continue;
    // Roles come from the *run's* artifact links, because a role is how the
    // run touched the file. Evidence says which task it was touched for; it
    // does not carry a role of its own, and minting one here would be this
    // layer inventing a fact.
    const roles = (index.artifactLinksByRun.get(row.runId) ?? [])
      .filter((link) => link.artifactId === row.targetId)
      .map((link) => link.role);
    artifacts.push({ artifact: toArtifactReference(artifact), roles });
  }

  return {
    workItemId,
    events,
    tabIds,
    artifacts,
    total: events.length + tabIds.length + artifacts.length,
  };
}
