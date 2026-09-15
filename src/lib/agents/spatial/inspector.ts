import { getRunEvents } from "@/lib/agents/selectors";
import { isWorkItemSpatialId } from "./types";
import type { AgentSpatialScene, SpatialId } from "./types";
import type {
  AgentRunArtifactRole,
  AgentRunLinkRole,
  AgentState,
} from "@/lib/agents/types";
import type { AgentInspectorSelection, InspectorRun } from "@/components/graph/graph-agent-panel";

/**
 * Assembling what the inspector shows.
 *
 * Pure, and outside the component, for the same reason the scene builder is:
 * the rules for "what does this run consist of" are testable without
 * rendering, and there is one answer rather than one per component.
 *
 * Everything it reads is already-sanitised domain state. It resolves ids to
 * readable names and nothing more — no provider knowledge, no filesystem, and
 * no field that could carry a transcript.
 */

/** How many recent events the inspector lists. Bounded so a long run cannot flood the panel. */
export const INSPECTOR_EVENT_LIMIT = 12;

/** How many of an agent's runs the inspector lists. */
export const INSPECTOR_RECENT_RUN_LIMIT = 6;

export type InspectorInput = {
  state: AgentState;
  scene: AgentSpatialScene;
  selectedId: SpatialId | null;
  /** Tab titles by id, supplied by the caller — this module does not import the tab store. */
  tabTitles: Map<string, string>;
};

/**
 * Builds the inspector's view of the current selection.
 *
 * Returns null when nothing relevant is selected, which the panel renders as
 * its empty/unavailable state rather than as a blank area.
 *
 * Every lookup tolerates a missing referent: a run whose agent has been
 * deleted, a link whose artifact is gone, a tab that no longer exists. Those
 * are ordinary consequences of deletion happening elsewhere, and the inspector
 * degrades to a readable fallback instead of throwing and taking the whole
 * sidebar down with it.
 */
export function buildInspectorSelection(input: InspectorInput): AgentInspectorSelection | null {
  const { state, scene, selectedId, tabTitles } = input;
  if (!selectedId) return null;

  const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
  const runsById = new Map(state.runs.map((run) => [run.id, run]));
  const artifactsById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));

  // Work items are resolved before nodes, because they are the one selection
  // that has no node: they live on `scene.workItems`, not `scene.nodes`, and
  // looking for one among the nodes would always miss.
  if (isWorkItemSpatialId(selectedId)) {
    const item = scene.workItems.find((candidate) => candidate.id === selectedId);
    // A work item whose run has since been filtered out, or deleted, is simply
    // no longer selectable. Returning null renders the panel's ordinary
    // "nothing selected" state rather than throwing.
    if (!item) return null;

    const run = runsById.get(item.runId);
    const agent = run ? agentsById.get(run.agentId) : undefined;

    const selection: AgentInspectorSelection = {
      kind: "workItem",
      item,
      // Every referent is optional and every fallback is honest: a run or
      // agent deleted out from under a selected item is an ordinary race, not
      // a crash, and naming it "Untitled run" beats rendering a blank row.
      runTitle: run?.title ?? "Untitled run",
      runSpatialId: item.runSpatialId,
      agentName: agent?.name ?? "Agent",
      provider: agent?.provider ?? "",
      files: run ? filesForRun(state, run.id, artifactsById) : [],
      tabs: run ? tabsForRun(state, run.id, tabTitles) : [],
      events: run ? getRunEvents(state, run.id).slice(-INSPECTOR_EVENT_LIMIT).reverse() : [],
    };
    if (run?.status) selection.runStatus = run.status;

    return selection;
  }

  const node = scene.nodes.find((candidate) => candidate.id === selectedId);
  if (!node) return null;

  if (node.kind === "agent") {
    const recentRuns: InspectorRun[] = state.runs
      .filter((run) => run.agentId === node.agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, INSPECTOR_RECENT_RUN_LIMIT)
      .map((run) => ({
        runId: run.id,
        title: run.title ?? node.label,
        status: run.status,
      }));

    return { kind: "agent", node, recentRuns };
  }

  if (node.kind === "artifact") {
    const touchedBy = state.artifactLinks
      .filter((link) => link.artifactId === node.artifactId)
      .map((link) => {
        const run = runsById.get(link.runId);
        const agent = run ? agentsById.get(run.agentId) : undefined;
        return {
          runId: link.runId,
          // A link can outlive its run if deletion raced a render; say so
          // rather than rendering an empty row.
          runTitle: run?.title ?? "Untitled run",
          agentName: agent?.name ?? "Agent",
          role: link.role,
        };
      })
      .sort((a, b) => a.runTitle.localeCompare(b.runTitle));

    return { kind: "artifact", node, touchedBy };
  }

  const run = runsById.get(node.runId);
  const agent = agentsById.get(node.agentId);

  const files = filesForRun(state, node.runId, artifactsById);
  const tabs = tabsForRun(state, node.runId, tabTitles);

  // Newest last in the domain; newest first reads better in a panel, and the
  // list is capped so a long-running session cannot fill the sidebar.
  const events = getRunEvents(state, node.runId).slice(-INSPECTOR_EVENT_LIMIT).reverse();

  const selection: AgentInspectorSelection = {
    kind: "run",
    node,
    agentName: agent?.name ?? "Agent",
    files,
    tabs,
    events,
    // The run's own work items, in plan order, straight off the scene so the
    // panel and the canvas cannot disagree about which are visible.
    workItems: scene.workItems.filter((item) => item.runId === node.runId),
    startedAt: run?.createdAt ?? node.createdAt,
  };
  // Only when the domain actually says the run ended — never inferred from a
  // session disappearing, which Phase 12 established cannot be interpreted.
  if (run?.endedAt !== undefined) selection.endedAt = run.endedAt;

  return selection;
}

/**
 * A run's files, resolved and ordered.
 *
 * Shared by the run and work-item selections so both describe the same run
 * identically — a work item's context is its run's context, and two
 * independent assemblies of it would eventually disagree.
 */
function filesForRun(
  state: AgentState,
  runId: string,
  artifactsById: Map<string, { id: string; relativePath: string }>
): { artifactId: string; relativePath: string; role: AgentRunArtifactRole }[] {
  return state.artifactLinks
    .filter((link) => link.runId === runId)
    .map((link) => {
      const artifact = artifactsById.get(link.artifactId);
      return artifact
        ? { artifactId: artifact.id, relativePath: artifact.relativePath, role: link.role }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** A run's tabs, resolved and ordered. Shared for the same reason as filesForRun. */
function tabsForRun(
  state: AgentState,
  runId: string,
  tabTitles: Map<string, string>
): { tabId: string; title: string; role: AgentRunLinkRole }[] {
  return state.links
    .filter((link) => link.runId === runId)
    .map((link) => ({
      tabId: link.tabId,
      // A tab the user has since deleted still had a real relationship; it is
      // named honestly rather than dropped, which would silently change the
      // count the canvas shows.
      title: tabTitles.get(link.tabId) ?? "Deleted tab",
      role: link.role,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
