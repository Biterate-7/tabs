import { knowledgeItemsOf, refKey } from "@/lib/memory/items";
import { itemActivityAt, itemKind } from "@/lib/memory/kinds";
import { subjectName } from "@/lib/product/subjects";
import { sourceKey } from "@/lib/resources/url";
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
};

/**
 * The graph of everything the person keeps, built from the stored records
 * alone. Deterministic: the same records always give the same nodes, edges
 * and order, so a layout keyed on ids stays put.
 */
export function buildKnowledgeGraph({ workspaces, sessions = [] }: BuildInput): KnowledgeGraph {
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const edgeIds = new Set<string>();
  const projectIds = new Set(workspaces.map((workspace) => workspace.id));

  function addEdge(a: string, b: string, kind: KnowledgeEdgeKind) {
    if (a === b) return;
    // Undirected relationships get one id whichever way round they are found.
    const [source, target] = kind === "contains" || kind === "session-project" ? [a, b] : a < b ? [a, b] : [b, a];
    const id = `${kind}:${source}|${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, source, target, kind });
  }

  // Which node(s) hold each address, so cross-project relationships are found in one pass.
  const byKey = new Map<string, string[]>();
  const projectOf = new Map<string, string>();
  const excerpts: { nodeId: string; key: string }[] = [];

  for (const workspace of workspaces) {
    const items = knowledgeItemsOf(workspace);
    const projectId = projectNodeId(workspace.id);
    let latest = workspace.createdAt;
    for (const item of items) latest = Math.max(latest, itemActivityAt(item));
    nodes.push({ id: projectId, kind: "project", label: subjectName(workspace), size: items.length, at: latest });

    for (const item of items) {
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
        at: itemActivityAt(item),
        ...(item.status === "failed" || item.status === "pending" || item.status === "processing" ? { unsettled: true } : {}),
      });
      addEdge(projectId, id, "contains");
      projectOf.set(id, workspace.id);
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
