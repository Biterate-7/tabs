import { relativePathBasename } from "@/lib/agents/paths";
import { artifactSpatialId } from "./types";
import type {
  AgentSpatialNodeUnion,
  AgentSpatialScene,
  SpatialId,
  WorkItemSummary,
} from "./types";

/**
 * Searching agent work.
 *
 * Extends Hubble's existing search *idea* — a pure matcher over state the app
 * already holds, the same shape as `matchesGraphQuery` in lib/graph/search.ts
 * — rather than introducing a second search engine. Nothing is indexed and
 * nothing is fetched.
 *
 * That is also the security property. The searchable surface is the scene,
 * which by construction holds only sanitised domain state: there is no path
 * from here to a transcript, a prompt, a tool result or a shell command,
 * because none of those exist in the data being searched.
 */

export type AgentSearchResultKind = "agent" | "run" | "artifact" | "workItem";

export type AgentSearchResult = {
  id: SpatialId;
  kind: AgentSearchResultKind;
  /** What the user sees as the result's name. */
  label: string;
  /** Second line — a run's activity, a file's project-relative path, a provider. */
  detail?: string;
  /** Human label for the result's type, so a run does not read as a tab. */
  typeLabel: string;
};

const TYPE_LABELS: Record<AgentSearchResultKind, string> = {
  agent: "Agent",
  run: "Agent run",
  artifact: "File",
  workItem: "Work item",
};

/**
 * The fields a query is matched against.
 *
 * Deliberately enumerated rather than "every string on the node": an allowlist
 * means a field added to the scene later cannot become searchable — and so
 * appear in a result list — without someone choosing to add it here.
 *
 * Note what is absent: an artifact's `projectPath` and its `id`, both of which
 * embed the absolute project root. Searching them would put that root in front
 * of the user, which is exactly the Phase 13 identity field that must stay a
 * key rather than a caption.
 */
function haystack(node: AgentSpatialNodeUnion): string[] {
  switch (node.kind) {
    case "agent":
      return [node.label, node.provider, node.status];
    case "run":
      return [node.label, node.provider, node.status, node.activity ?? ""];
    case "artifact":
      // Both, so "artifacts.ts" and "src/lib/agents" each find it.
      return [node.label, node.relativePath];
  }
}

/**
 * Matches agent entities in the current scene.
 *
 * Scoped to the scene rather than to the whole domain, which gives two
 * properties for free: search respects the current workspace, and it respects
 * the active filter. That is the documented interaction — **search looks
 * within what is currently eligible** — so every result corresponds to
 * something the user can actually be shown. Searching for a completed run
 * while the Active filter is on finds nothing, rather than finding a result
 * that then cannot be selected.
 */
export function searchAgentScene(scene: AgentSpatialScene, query: string): AgentSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: AgentSearchResult[] = [];

  for (const node of scene.nodes) {
    if (!haystack(node).some((value) => value.toLowerCase().includes(q))) continue;

    const result: AgentSearchResult = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      typeLabel: TYPE_LABELS[node.kind],
    };

    if (node.kind === "run" && node.activity) result.detail = node.activity;
    else if (node.kind === "artifact") result.detail = node.relativePath;
    else if (node.kind === "agent") result.detail = node.provider;

    results.push(result);
  }

  for (const item of scene.workItems) {
    if (!workItemHaystack(item).some((value) => value.toLowerCase().includes(q))) continue;

    const result: AgentSearchResult = {
      id: item.id,
      kind: "workItem",
      label: item.title,
      typeLabel: TYPE_LABELS.workItem,
    };
    // The summary is the more informative second line when there is one; the
    // status is the honest fallback, and never nothing.
    result.detail = item.summary ?? WORK_ITEM_STATUS_LABELS[item.status];
    results.push(result);
  }

  // Work items first, then runs: someone searching agent work is usually
  // looking for *what is being done* before *which session is doing it*.
  const rank: Record<AgentSearchResultKind, number> = {
    workItem: 0,
    run: 1,
    artifact: 2,
    agent: 3,
  };
  results.sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));

  return results;
}

/**
 * Human labels for a work item's status.
 *
 * Here rather than in the component because search matches against them: a
 * user typing "blocked" should find blocked work, which only works if the
 * word being matched is the word being shown.
 */
export const WORK_ITEM_STATUS_LABELS: Record<WorkItemSummary["status"], string> = {
  pending: "Pending",
  active: "Active",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * The fields of a work item a query is matched against.
 *
 * An allowlist, for the same reason `haystack` is one. Note the omissions:
 * `workItemId`, `runId` and both spatial ids are absent, so no opaque
 * identifier can be surfaced by searching for it — and `externalId`, the
 * provider's own task id, is not even present on the scene-side summary, so
 * there is nothing here to exclude.
 */
function workItemHaystack(item: WorkItemSummary): string[] {
  return [item.title, item.summary ?? "", WORK_ITEM_STATUS_LABELS[item.status], item.status];
}

export type HiddenArtifactInput = {
  artifacts: { id: string; relativePath: string; workspaceId: string }[];
  artifactLinks: { artifactId: string; runId: string }[];
  workspaceId: string;
  /** Runs the current filter allows, so a hidden file cannot outlive its run. */
  visibleRunIds: Set<string>;
};

/**
 * Files the scene has not disclosed, matched by path.
 *
 * Files stay collapsed until their run is selected (progressive disclosure),
 * so without this, searching for one would find nothing until the user had
 * already found it — which defeats the point of searching. These results carry
 * the artifact's own spatial id, and selecting one discloses it, because
 * selecting an artifact opens the runs around it.
 *
 * Still filter-scoped and workspace-scoped: a file whose every run is hidden
 * does not appear.
 */
export function searchHiddenArtifacts(
  input: HiddenArtifactInput,
  query: string,
  alreadyShown: Set<SpatialId>
): AgentSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const reachable = new Set<string>();
  for (const link of input.artifactLinks) {
    if (input.visibleRunIds.has(link.runId)) reachable.add(link.artifactId);
  }

  const results: AgentSearchResult[] = [];
  for (const artifact of input.artifacts) {
    if (artifact.workspaceId !== input.workspaceId) continue;
    if (!reachable.has(artifact.id)) continue;
    if (alreadyShown.has(artifactSpatialId(artifact.id))) continue;
    if (!artifact.relativePath.toLowerCase().includes(q)) continue;

    results.push({
      id: artifactSpatialId(artifact.id),
      kind: "artifact",
      label: relativePathBasename(artifact.relativePath),
      detail: artifact.relativePath,
      typeLabel: TYPE_LABELS.artifact,
    });
  }

  return results.sort((a, b) => a.label.localeCompare(b.label));
}

/** Everything matching, scene results first, capped so a broad query cannot flood the panel. */
export function searchAgentWork(
  scene: AgentSpatialScene,
  hidden: HiddenArtifactInput,
  query: string,
  limit = 25
): AgentSearchResult[] {
  const shown = searchAgentScene(scene, query);
  const shownIds = new Set(shown.map((result) => result.id));
  return [...shown, ...searchHiddenArtifacts(hidden, query, shownIds)].slice(0, limit);
}
