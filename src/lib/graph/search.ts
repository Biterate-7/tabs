import type { GraphNode } from "./types";

export function matchesGraphQuery(node: GraphNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tab = node.tab;
  return (
    (tab.title ?? "").toLowerCase().includes(q) ||
    tab.url.toLowerCase().includes(q) ||
    tab.domain.toLowerCase().includes(q) ||
    node.workspaceName.toLowerCase().includes(q) ||
    (tab.category ?? "").toLowerCase().includes(q)
  );
}

export function searchGraphNodes(nodes: GraphNode[], query: string): GraphNode[] {
  const q = query.trim();
  if (!q) return [];
  return nodes.filter((node) => matchesGraphQuery(node, q));
}
