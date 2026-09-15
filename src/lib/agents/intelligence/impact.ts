import { toArtifactReference, toWorkItemReference } from "./references";
import type { AgentDomainIndex } from "./domain-index";
import type { AgentRunImpact, ArtifactImpact } from "./types";

/**
 * What a run has touched.
 *
 * The question this answers is "what existing workspace objects are
 * meaningfully connected to this run?", and the word doing the work is
 * *existing*. Impact never introduces an object; it selects among the ones
 * the workspace already holds, following relationships the domain already
 * stores.
 *
 * ## The four relationships, and their evidence
 *
 * | reported | because |
 * |---|---|
 * | work item | `AgentWorkItem.runId` names this run |
 * | file | an `AgentRunArtifactLink` joins them |
 * | context tab | an `AgentRunLink` with role `context` |
 * | produced tab | an `AgentRunLink` with role `produced` |
 *
 * Each is a stored row, observed once and recorded. None is inferred.
 *
 * ## What is not reported, and why
 *
 * **file -> tab.** The domain has no such relationship. A file and a tab can
 * both belong to the same run without having anything to do with each other,
 * and matching a filename against a URL would manufacture an edge out of a
 * coincidence of spelling.
 *
 * **work item -> file.** The relationship a user would most want, and the one
 * the domain most clearly does not record. Nothing observes which file was
 * touched for which task. Joining them through their shared run would emit an
 * edge for every (item, file) pair - a cross product presented as knowledge.
 * See the note on `AgentRelationshipKind`.
 */

/**
 * Builds a run's impact.
 *
 * Returns `undefined` for a run the index does not hold, rather than an empty
 * impact: "this run touched nothing" and "there is no such run" are different
 * answers, and a caller that cannot tell them apart will render the wrong
 * empty state.
 *
 * Ordering is deterministic throughout - files by path, tabs by id - so the
 * same state always produces the same value, which is what makes the reload
 * equivalence test in §33 meaningful.
 */
export function getAgentRunImpact(
  index: AgentDomainIndex,
  runId: string
): AgentRunImpact | undefined {
  if (!index.runsById.has(runId)) return undefined;

  const workItems = (index.workItemsByRun.get(runId) ?? []).map(toWorkItemReference);

  // A run can hold several roles on one file (inspected, then edited). They
  // are collected onto a single entry rather than emitted as duplicate files,
  // because "3 files" must mean three files.
  const rolesByArtifact = new Map<string, ArtifactImpact>();
  for (const link of index.artifactLinksByRun.get(runId) ?? []) {
    const existing = rolesByArtifact.get(link.artifactId);
    if (existing) {
      if (!existing.roles.includes(link.role)) existing.roles.push(link.role);
      continue;
    }
    // The index has already dropped links whose artifact is missing or
    // belongs to another workspace, so this lookup resolves - but it is
    // written to tolerate a miss rather than assert one.
    const artifact = index.artifactsById.get(link.artifactId);
    if (!artifact) continue;
    rolesByArtifact.set(link.artifactId, {
      artifact: toArtifactReference(artifact),
      roles: [link.role],
    });
  }

  const artifacts = [...rolesByArtifact.values()].sort((a, b) =>
    a.artifact.relativePath.localeCompare(b.artifact.relativePath)
  );
  for (const entry of artifacts) entry.roles.sort();

  const contextTabIds = new Set<string>();
  const producedTabIds = new Set<string>();
  for (const link of index.tabLinksByRun.get(runId) ?? []) {
    if (link.role === "context") contextTabIds.add(link.tabId);
    else producedTabIds.add(link.tabId);
  }

  // The union, not the concatenation: a tab that is both context and produced
  // is one affected tab, and counting it twice would overstate the run.
  const affectedTabIds = new Set<string>([...contextTabIds, ...producedTabIds]);

  return {
    runId,
    workItems,
    artifacts,
    contextTabIds: sorted(contextTabIds),
    producedTabIds: sorted(producedTabIds),
    affectedTabIds: sorted(affectedTabIds),
  };
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}
