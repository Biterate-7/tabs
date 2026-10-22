import { itemOfSavedTab, knowledgeItemsOf, refKey } from "@/lib/memory/items";
import { itemActivityAt, itemKind } from "@/lib/memory/kinds";
import { subjectName } from "@/lib/product/subjects";
import { sourceKey } from "@/lib/resources/url";
import type { TabDependency } from "@/lib/dependencies/types";
import type { ManualConnection } from "@/lib/graph/types";
import type { KnowledgeItem } from "@/lib/memory/items";
import type { TabSession } from "@/lib/sessions/types";
import type { Workspace } from "@/lib/workspace/types";
import type { KnowledgeEdge, KnowledgeEdgeKind, KnowledgeGraph, KnowledgeNode } from "./types";

export const projectNodeId = (workspaceId: string) => `p:${workspaceId}`;
export const sessionNodeId = (sessionId: string) => `s:${sessionId}`;
export const itemNodeId = (workspaceId: string, key: string) => `i:${workspaceId}:${key}`;

/**
 * Past this many copies of one address, a "same source" relationship is
 * drawn as a chain rather than every pair: five projects saving one paper
 * are connected by four lines, not ten, and the relationship still reads.
 */
const MAX_PAIRWISE = 4;

export type BuildInput = {
  workspaces: readonly Workspace[];
  /** Saved browser sessions. Omit where sessions do not exist (Hubble Desktop). */
  sessions?: readonly TabSession[];
  /** Links the person drew between two saved tabs (by tab id). */
  links?: readonly ManualConnection[];
  /** Dependencies the person recorded between saved tabs (by tab id). */
  dependencies?: readonly TabDependency[];
};

/**
 * Everything a project holds, as the graph shows it: its knowledge items,
 * then every saved tab that is not (yet) a source. Each tab appears once,
 * whichever it is, under the same node id — so a tab that later becomes a
 * source keeps its place.
 */
export function graphItemsOf(workspace: Pick<Workspace, "id" | "tabs" | "notes">): { item: KnowledgeItem; savedTab: boolean }[] {
  const out = knowledgeItemsOf(workspace).map((item) => ({ item, savedTab: false }));
  for (const tab of workspace.tabs) if (!tab.resource) out.push({ item: itemOfSavedTab(workspace.id, tab), savedTab: true });
  return out;
}

/**
 * The graph of everything the person keeps, built from the stored records
 * alone. Deterministic: the same records always give the same nodes, edges
 * and order, so a layout keyed on ids stays put.
 */
export function buildKnowledgeGraph({ workspaces, sessions = [], links = [], dependencies = [] }: BuildInput): KnowledgeGraph {
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const edgeIds = new Set<string>();
  const projectIds = new Set(workspaces.map((workspace) => workspace.id));

  function addEdge(a: string, b: string, kind: KnowledgeEdgeKind, extra: Pick<KnowledgeEdge, "dependency"> = {}) {
    if (a === b) return;
    // Undirected relationships get one id whichever way round they are found.
    const [source, target] = kind === "contains" || kind === "session-project" || kind === "depends-on" ? [a, b] : a < b ? [a, b] : [b, a];
    const id = `${kind}:${source}|${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, source, target, kind, ...extra });
  }

  // Which node(s) hold each address, so cross-project relationships are found in one pass.
  const byKey = new Map<string, string[]>();
  const projectOf = new Map<string, string>();
  const excerpts: { nodeId: string; key: string }[] = [];
  // Saved tabs by their own id: links and dependencies name tabs, not nodes.
  const nodeOfTab = new Map<string, string>();

  for (const workspace of workspaces) {
    const entries = graphItemsOf(workspace);
    const tabs = new Map(workspace.tabs.map((tab) => [tab.id, tab]));
    const projectId = projectNodeId(workspace.id);
    let latest = workspace.createdAt;
    for (const { item } of entries) latest = Math.max(latest, itemActivityAt(item));
    nodes.push({ id: projectId, kind: "project", label: subjectName(workspace), size: entries.length, at: latest });

    for (const { item, savedTab } of entries) {
      const kind = itemKind(item);
      const id = itemNodeId(workspace.id, refKey(item.ref));
      nodes.push({
        id,
        kind,
        label: item.title,
        projectId: workspace.id,
        item,
        type: item.type,
        ...(item.provider ? { provider: item.provider } : {}),
        // A tab saved before Hubble kept dates has none: it is as old as its project, never "1970".
        at: itemActivityAt(item) || workspace.createdAt,
        ...(item.status === "failed" || item.status === "pending" || item.status === "processing" ? { unsettled: true } : {}),
        ...(savedTab ? { savedTab: true } : {}),
        ...(item.ref.kind === "source" && tabs.get(item.ref.tabId)?.favicon ? { pageIcon: tabs.get(item.ref.tabId)!.favicon } : {}),
      });
      addEdge(projectId, id, "contains");
      projectOf.set(id, workspace.id);
      if (item.ref.kind === "source") nodeOfTab.set(item.ref.tabId, id);
      if (!item.url) continue;
      const key = sourceKey(item.url);
      if (!key) continue;
      // An excerpt points at the page it came from; it is not itself a copy of that page.
      if (item.type === "excerpt") excerpts.push({ nodeId: id, key });
      else byKey.set(key, [...(byKey.get(key) ?? []), id]);
    }
  }

  // The same address saved in more than one project.
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    const distinctProjects = new Set(ids.map((id) => projectOf.get(id)));
    if (distinctProjects.size < 2) continue;
    if (ids.length <= MAX_PAIRWISE) {
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) if (projectOf.get(ids[a]!) !== projectOf.get(ids[b]!)) addEdge(ids[a]!, ids[b]!, "same-source");
    } else {
      for (let a = 1; a < ids.length; a++) addEdge(ids[a - 1]!, ids[a]!, "same-source");
    }
  }

  // An excerpt and the saved page it quotes.
  for (const excerpt of excerpts) for (const target of byKey.get(excerpt.key) ?? []) addEdge(excerpt.nodeId, target, "excerpt-of");

  for (const session of sessions) {
    const id = sessionNodeId(session.id);
    const linkedProject = session.workspaceId && projectIds.has(session.workspaceId) ? session.workspaceId : undefined;
    nodes.push({
      id,
      kind: "session",
      label: session.name,
      sessionId: session.id,
      tabCount: session.tabs.length,
      ...(linkedProject ? { projectId: linkedProject } : {}),
      at: Math.max(session.updatedAt, session.lastRestoredAt ?? 0),
    });
    if (linkedProject) addEdge(projectNodeId(linkedProject), id, "session-project");
    for (const tab of session.tabs) {
      const key = sourceKey(tab.url);
      if (!key) continue;
      for (const target of byKey.get(key) ?? []) addEdge(id, target, "session-source");
    }
  }

  // The person's own relationships. One whose tab has since gone is simply not drawn.
  for (const link of links) {
    const a = nodeOfTab.get(link.a);
    const b = nodeOfTab.get(link.b);
    if (a && b) addEdge(a, b, "linked");
  }
  for (const dependency of dependencies) {
    const parent = nodeOfTab.get(dependency.parentTabId);
    const child = nodeOfTab.get(dependency.childTabId);
    if (parent && child) addEdge(parent, child, "depends-on", { dependency: { id: dependency.id, ...(dependency.type ? { type: dependency.type } : {}) } });
  }

  return { nodes, edges };
}

/** Each node's neighbours, for focus and keyboard traversal. */
export function adjacency(graph: KnowledgeGraph): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const node of graph.nodes) map.set(node.id, new Set());
  for (const edge of graph.edges) {
    map.get(edge.source)?.add(edge.target);
    map.get(edge.target)?.add(edge.source);
  }
  return map;
}
