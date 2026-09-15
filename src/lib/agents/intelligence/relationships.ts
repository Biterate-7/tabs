import type { AgentDomainIndex } from "./domain-index";
import type { AgentObjectRelationship } from "./types";

/**
 * A run's relationships, as a flat edge list.
 *
 * The same facts `getAgentRunImpact` reports, in the shape a graph wants:
 * uniform `{ kind, runId, targetId }` rows rather than four differently-typed
 * collections. Both exist because both questions get asked - "what does this
 * run consist of" wants the grouped form, "what should I highlight" wants the
 * flat one - and deriving one from the other at the call site would push the
 * same join into every consumer.
 *
 * Every edge is backed by a stored row. There is no similarity scoring, no
 * string matching, no URL comparison and no filename heuristic anywhere in
 * this module, and `relationships.test.ts` pins that none appears later.
 */

/** Deterministic, derived from the edge itself - see `agentRunLinkId` for the precedent. */
function relationshipId(kind: string, runId: string, targetId: string): string {
  return `${kind}::${runId}::${targetId}`;
}

/**
 * Every relationship this run actually has.
 *
 * Returns `[]` for an unknown run - an edge list is a collection, and an
 * absent run simply contributes no edges. (Contrast `getAgentRunImpact`,
 * which distinguishes "no such run" from "touched nothing" because its caller
 * renders a different empty state for each.)
 *
 * Emitted in a fixed order - work items, files, context tabs, produced tabs -
 * with each group internally ordered by the index's own ordering, so the list
 * is stable across recomputation.
 */
export function getAgentRelationshipsForRun(
  index: AgentDomainIndex,
  runId: string
): AgentObjectRelationship[] {
  if (!index.runsById.has(runId)) return [];

  const relationships: AgentObjectRelationship[] = [];

  for (const item of index.workItemsByRun.get(runId) ?? []) {
    relationships.push({
      id: relationshipId("run-work-item", runId, item.id),
      kind: "run-work-item",
      runId,
      targetId: item.id,
    });
  }

  // One edge per (file, role). A run that inspected and then edited a file
  // genuinely holds two relationships to it, and collapsing them would lose
  // the distinction the roles exist to draw. Identity includes the role for
  // the same reason `agentRunLinkId` does.
  const seenArtifactRoles = new Set<string>();
  for (const link of index.artifactLinksByRun.get(runId) ?? []) {
    const key = `${link.artifactId}::${link.role}`;
    if (seenArtifactRoles.has(key)) continue;
    seenArtifactRoles.add(key);
    relationships.push({
      id: relationshipId(`run-artifact:${link.role}`, runId, link.artifactId),
      kind: "run-artifact",
      runId,
      targetId: link.artifactId,
      role: link.role,
    });
  }

  const seenContext = new Set<string>();
  const seenProduced = new Set<string>();
  for (const link of index.tabLinksByRun.get(runId) ?? []) {
    const seen = link.role === "context" ? seenContext : seenProduced;
    if (seen.has(link.tabId)) continue;
    seen.add(link.tabId);
    relationships.push({
      id: relationshipId(`run-${link.role}-tab`, runId, link.tabId),
      kind: link.role === "context" ? "run-context-tab" : "run-produced-tab",
      runId,
      targetId: link.tabId,
    });
  }

  return relationships;
}

/**
 * The runs in one workspace that touched a file, newest first.
 *
 * The reverse of `run -> artifact`, and the lookup a file-side selection
 * needs: a file has no position on the canvas until its run is disclosed, so
 * "focus this file" has to mean "focus a run that worked on it".
 *
 * Workspace-scoped, so a file with the same relative path in another
 * workspace cannot pull the camera across the boundary.
 */
export function getRunsTouchingArtifact(
  index: AgentDomainIndex,
  workspaceId: string,
  artifactId: string
): string[] {
  if (!workspaceId || !artifactId) return [];

  const runs = index.runsByWorkspace.get(workspaceId);
  if (!runs?.length) return [];

  const touching: string[] = [];
  for (const run of runs) {
    const links = index.artifactLinksByRun.get(run.id);
    if (!links) continue;
    if (links.some((link) => link.artifactId === artifactId)) touching.push(run.id);
  }

  // `runsByWorkspace` is already newest-first, so the first entry is the most
  // recent run to have touched the file — the one a user most likely means.
  return touching;
}

/**
 * The workspace objects a selected run should highlight.
 *
 * Returned as id sets rather than as styling, so the renderer decides how
 * emphasis is expressed and this module stays free of presentation detail -
 * the same split `emphasizedEdgeIds` already uses.
 *
 * Highlighting is **per selection**, never global. Drawing every run's
 * relationships at once would turn a workspace with real history into the
 * unreadable web this phase is explicitly meant not to produce; a command
 * centre answers "what does *this* touch?", one selection at a time.
 */
export function getHighlightedObjectIds(
  index: AgentDomainIndex,
  runId: string | null | undefined
): { workItemIds: Set<string>; artifactIds: Set<string>; tabIds: Set<string> } {
  const empty = {
    workItemIds: new Set<string>(),
    artifactIds: new Set<string>(),
    tabIds: new Set<string>(),
  };
  if (!runId) return empty;

  for (const relationship of getAgentRelationshipsForRun(index, runId)) {
    switch (relationship.kind) {
      case "run-work-item":
        empty.workItemIds.add(relationship.targetId);
        break;
      case "run-artifact":
        empty.artifactIds.add(relationship.targetId);
        break;
      case "run-context-tab":
      case "run-produced-tab":
        empty.tabIds.add(relationship.targetId);
        break;
    }
  }

  return empty;
}
