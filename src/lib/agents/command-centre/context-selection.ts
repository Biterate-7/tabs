import { itemsOfType } from "@/lib/agents/context/types";
import type {
  AgentContextOmissionReason,
  AgentContextRequest,
  AgentContextSnapshot,
  AgentContextSourceType,
} from "@/lib/agents/context/types";

/**
 * What the user ticked, and how it becomes a Phase E request.
 *
 * ## Why the selection is its own type
 *
 * `AgentContextRequest` is the resolver's input and is deliberately strict:
 * `sources` may not be empty, every id is named explicitly, and there is no
 * "everything" shorthand. A checkbox list, meanwhile, is routinely in a state
 * that is not yet a valid request — nothing ticked, a graph depth chosen with
 * no centre tab, a workspace unticked after its tabs were picked.
 *
 * Keeping those two shapes apart means the picker can hold an *incomplete*
 * selection without ever being able to hand the resolver a malformed request:
 * `selectionToRequest` returns `null` for a selection that is not yet a
 * question, and the caller has nothing to send. The alternative — letting
 * components assemble a request field by field — is how `sources: []` reaches
 * a resolver that answers `invalid-request` and a UI that says nothing.
 *
 * Nothing here resolves anything. This module cannot read a workspace, and the
 * snapshot it summarizes was minted by the bridge.
 */

export type ContextSelection = {
  workspaceIds: readonly string[];
  collectionIds: readonly string[];
  tabIds: readonly string[];
  /** The project whose metadata to include. The session's project, when there is one. */
  projectIds: readonly string[];
  /**
   * Graph expansion. `centerTabIds` empty means the graph source is not asked
   * for at all, however the depth is set — a depth with nothing to expand from
   * is not a request, it is a number.
   */
  graph: { centerTabIds: readonly string[]; depth: number };
  /** Recent agent runs. `0` means the source is not requested. */
  activityLimit: number;
  /**
   * Whether to send the user's per-tab notes.
   *
   * Off by default here exactly as it is off by default in the resolver, and
   * for the resolver's stated reason: a note is the one field where a person
   * has typed prose of their own.
   */
  includeNotes: boolean;
};

export const EMPTY_SELECTION: ContextSelection = {
  workspaceIds: [],
  collectionIds: [],
  tabIds: [],
  projectIds: [],
  graph: { centerTabIds: [], depth: 1 },
  activityLimit: 0,
  includeNotes: false,
};

export function isEmptySelection(selection: ContextSelection): boolean {
  return (
    selection.workspaceIds.length === 0 &&
    selection.collectionIds.length === 0 &&
    selection.tabIds.length === 0 &&
    selection.projectIds.length === 0 &&
    selection.graph.centerTabIds.length === 0 &&
    selection.activityLimit === 0
  );
}

/** Adds or removes one id, without caring which list it belongs to. */
export function toggleId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/**
 * Which sources a selection actually asks for.
 *
 * Derived from what is ticked rather than declared separately, so a source can
 * never be requested with no ids — which resolves to nothing and reports an
 * empty snapshot the user cannot explain.
 *
 * `workspace` is requested whenever any workspace is named, and `tab` rides
 * along with it: "attach this workspace" means the workspace *and its tabs*,
 * which is the bounded version of that intent the resolver documents.
 */
export function selectedSources(selection: ContextSelection): readonly AgentContextSourceType[] {
  const sources: AgentContextSourceType[] = [];

  if (selection.workspaceIds.length > 0) sources.push("workspace", "tab");
  else if (selection.tabIds.length > 0) sources.push("tab");

  if (selection.collectionIds.length > 0) sources.push("collection");
  if (selection.projectIds.length > 0) sources.push("project");
  if (selection.graph.centerTabIds.length > 0) sources.push("graph");
  if (selection.activityLimit > 0) sources.push("agent_activity");

  return sources;
}

/**
 * The scope a selection runs inside.
 *
 * ## Why the scope is widened to the owner's whole set, not the selection
 *
 * Scope is an *authorization* boundary — "which workspaces may this request
 * reach" — and is checked against the account that loaded the data. It is not
 * the selection. Narrowing scope to the ticked workspaces would look tidier
 * and would break the two cases that matter: a collection or a tab named
 * directly lives in a workspace the user did not also tick, and the resolver
 * would drop it as out of scope with no explanation the user could act on.
 *
 * So the caller passes the workspaces the signed-in account actually owns, and
 * the selection decides what is *asked for* within them.
 */
export function selectionToRequest(
  selection: ContextSelection,
  scope: { ownerId: string | null; workspaceIds: readonly string[]; projectIds: readonly string[] }
): AgentContextRequest | null {
  const sources = selectedSources(selection);
  if (sources.length === 0) return null;

  // A scope with no workspaces is not well-formed (`isWellFormedScope`
  // requires a non-empty list), and a request built on one would be refused
  // as `invalid-request` — a failure the user would read as "context is
  // broken" rather than "you have no workspaces".
  if (scope.workspaceIds.length === 0) return null;

  const request: AgentContextRequest = {
    scope: {
      ownerId: scope.ownerId,
      workspaceIds: [...scope.workspaceIds],
      projectIds: [...scope.projectIds],
    },
    sources,
    includeNotes: selection.includeNotes,
  };

  // Each id list is attached only when it has entries: the resolver treats
  // `undefined` and `[]` differently for tabs, where an empty array means
  // "this exact empty set" and absence means "whatever the workspaces hold".
  return {
    ...request,
    ...(selection.workspaceIds.length > 0 ? { workspaceIds: [...selection.workspaceIds] } : {}),
    ...(selection.tabIds.length > 0 ? { tabIds: [...selection.tabIds] } : {}),
    ...(selection.collectionIds.length > 0
      ? { collectionIds: [...selection.collectionIds] }
      : {}),
    ...(selection.projectIds.length > 0 ? { projectIds: [...selection.projectIds] } : {}),
    ...(selection.graph.centerTabIds.length > 0
      ? { graph: { centerTabIds: [...selection.graph.centerTabIds], depth: selection.graph.depth } }
      : {}),
    ...(selection.activityLimit > 0
      ? { agentActivity: { limit: selection.activityLimit } }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Describing what was attached
 * ------------------------------------------------------------------ */

/**
 * One line per source type, for the context inspector.
 *
 * Counted from the snapshot's *items* rather than from the request, which is
 * the whole point: the request is what was asked for and the snapshot is what
 * was resolved, and the gap between them is exactly what the user needs to
 * see. A workspace that was deleted between selection and resolution appears
 * in one and not the other.
 */
export type ContextSummaryRow = {
  sourceType: AgentContextSourceType;
  label: string;
  count: number;
  /** A second fact, where the type has one worth stating. */
  detail?: string;
};

const SOURCE_LABEL: Record<AgentContextSourceType, string> = {
  workspace: "Workspaces",
  tab: "Tabs",
  collection: "Collections",
  relationship: "Relationships",
  graph: "Graph",
  project: "Projects",
  agent_activity: "Agent activity",
};

export function summarizeSnapshot(snapshot: AgentContextSnapshot): readonly ContextSummaryRow[] {
  const rows: ContextSummaryRow[] = [];

  for (const sourceType of [
    "workspace",
    "tab",
    "collection",
    "relationship",
    "graph",
    "project",
    "agent_activity",
  ] as const) {
    const items = itemsOfType(snapshot, sourceType);
    if (items.length === 0) continue;

    // The graph is the one source whose item count is not the interesting
    // number: three centres of depth 2 is "3 centres, 40 nodes, 60 edges",
    // and reporting only "3" would understate what the agent was told by an
    // order of magnitude.
    if (sourceType === "graph") {
      const graphItems = itemsOfType(snapshot, "graph");
      const nodes = graphItems.reduce((total, item) => total + item.nodes.length, 0);
      const edges = graphItems.reduce((total, item) => total + item.edges.length, 0);
      const depth = graphItems.reduce((deepest, item) => Math.max(deepest, item.depth), 0);
      rows.push({
        sourceType,
        label: SOURCE_LABEL[sourceType],
        count: graphItems.length,
        detail: `Depth ${depth} · ${nodes} nodes · ${edges} edges`,
      });
      continue;
    }

    rows.push({ sourceType, label: SOURCE_LABEL[sourceType], count: items.length });
  }

  return rows;
}

/**
 * The one-line version, for the composer's context indicator.
 *
 * Names the first source and totals the rest, because the composer has one
 * line and "Research · 12 tabs · 3 collections · 2 more" is what fits. The
 * full breakdown is the inspector's job, and it is always one click away.
 */
export function summarizeAttachment(snapshot: AgentContextSnapshot): string {
  const rows = summarizeSnapshot(snapshot)
  if (rows.length === 0) return "Nothing attached"

  return rows
    .map((row) => `${row.count} ${row.label.toLowerCase()}`)
    .slice(0, 3)
    .join(" · ")
}

/**
 * What changed between two snapshots, by source type.
 *
 * Phase E refreshes by minting a *second* snapshot rather than mutating the
 * first, which is what makes this diff possible at all — both sides still
 * exist. Reported per source type rather than per item because that is the
 * granularity the inspector shows and the granularity a user asked "what did
 * refreshing do?" can actually act on.
 */
export type ContextDelta = {
  sourceType: AgentContextSourceType;
  label: string;
  /** Positive for added, negative for removed. Never zero — unchanged rows are omitted. */
  change: number;
};

export function diffSnapshots(
  previous: AgentContextSnapshot,
  next: AgentContextSnapshot
): readonly ContextDelta[] {
  const deltas: ContextDelta[] = [];

  for (const sourceType of [
    "workspace",
    "tab",
    "collection",
    "relationship",
    "graph",
    "project",
    "agent_activity",
  ] as const) {
    const change = itemsOfType(next, sourceType).length - itemsOfType(previous, sourceType).length;
    if (change !== 0) deltas.push({ sourceType, label: SOURCE_LABEL[sourceType], change });
  }

  return deltas;
}

/** `+2 tabs · -1 collection`, or `null` when nothing moved. */
export function describeDelta(deltas: readonly ContextDelta[]): string | null {
  if (deltas.length === 0) return null;
  return deltas
    .map((delta) => `${delta.change > 0 ? "+" : ""}${delta.change} ${delta.label.toLowerCase()}`)
    .join(" · ");
}

/**
 * Why something the user picked did not make it in.
 *
 * The omission reasons are the resolver's own; this only gives each one a
 * sentence. A truncated snapshot that said nothing would leave the user
 * believing the agent can see more than it can, which is the specific
 * misunderstanding scoped context exists to prevent.
 */
export const OMISSION_REASON_LABEL: Record<AgentContextOmissionReason, string> = {
  "not-found": "No longer exists",
  "out-of-scope": "Outside this account's workspaces",
  "source-not-requested": "That kind of context was not requested",
  "limit-workspaces": "Too many workspaces",
  "limit-tabs": "Too many tabs",
  "limit-collections": "Too many collections",
  "limit-collection-members": "Collection too large to list in full",
  "limit-relationships": "Too many relationships",
  "limit-graph-nodes": "Graph too large",
  "limit-graph-edges": "Graph too densely connected",
  "limit-projects": "Too many projects",
  "limit-agent-activity": "Too many runs",
  "limit-items": "The context was already full",
  "limit-characters": "The context reached its size limit",
  "hosted-runtime": "Local-only, and this build cannot resolve it",
};

export function describeOmissionReason(reason: AgentContextOmissionReason): string {
  return OMISSION_REASON_LABEL[reason];
}
