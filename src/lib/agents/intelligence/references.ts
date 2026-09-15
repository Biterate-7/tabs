import type { ArtifactReference, RunReference, WorkItemReference } from "./types";
import type { AgentRun, AgentWorkItem, WorkArtifact } from "@/lib/agents/types";

/**
 * Domain entity to client-visible reference.
 *
 * This is the presentation boundary of the intelligence layer, and it is a
 * *projection* rather than a pass-through on purpose. Three stored fields
 * must never be rendered - `AgentRun.externalId`, `AgentWorkItem.externalId`
 * and `WorkArtifact.projectPath` - and the only way to guarantee that across
 * a growing set of read models is to make the narrowing happen in exactly one
 * place that every one of them goes through.
 *
 * The alternative, returning the domain objects and trusting each consumer to
 * render only safe fields, fails the first time someone writes
 * `{...artifact}` into a component. Here, the absolute project root is simply
 * not in the value that leaves this module.
 *
 * Each function builds a fresh object with named fields. Spreading the source
 * and deleting the unwanted keys would be shorter and would silently carry
 * through any field added to the domain later - which is precisely the
 * failure mode this exists to prevent.
 */

/** A run, narrowed. Drops `externalId` (session identity) and `workspaceId`. */
export function toRunReference(run: AgentRun): RunReference {
  const reference: RunReference = {
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
  if (run.title !== undefined) reference.title = run.title;
  if (run.currentActivity !== undefined) reference.currentActivity = run.currentActivity;
  // Only when the domain actually recorded an ending. Never inferred from a
  // session going quiet, which Phase 12 established cannot be interpreted.
  if (run.endedAt !== undefined) reference.endedAt = run.endedAt;
  return reference;
}

/** A work item, narrowed. Drops `externalId` (provider task id) and `workspaceId`. */
export function toWorkItemReference(item: AgentWorkItem): WorkItemReference {
  const reference: WorkItemReference = {
    workItemId: item.id,
    runId: item.runId,
    title: item.title,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.summary !== undefined) reference.summary = item.summary;
  if (item.progress !== undefined) reference.progress = item.progress;
  if (item.startedAt !== undefined) reference.startedAt = item.startedAt;
  if (item.completedAt !== undefined) reference.completedAt = item.completedAt;
  return reference;
}

/**
 * A file, narrowed. Drops `projectPath` - the absolute local root.
 *
 * The single most important line in this module. `relativePath` is already
 * guaranteed project-relative and non-escaping by Phase 13 (see
 * lib/agents/paths.ts), so what survives here is safe to put on screen.
 */
export function toArtifactReference(artifact: WorkArtifact): ArtifactReference {
  return {
    artifactId: artifact.id,
    relativePath: artifact.relativePath,
    updatedAt: artifact.updatedAt,
  };
}
