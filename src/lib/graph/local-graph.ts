import type { GraphDepth, GraphEdge } from "./types";

export function depthToNumber(depth: GraphDepth): number {
  return depth === "infinite" ? Infinity : depth;
}

/**
 * BFS outward from `centerId` up to `depth` hops over `edges`, returning the
 * set of reachable node ids (including the center itself). `depth:
 * "infinite"` walks the whole connected component. Missing/unknown center
 * ids resolve to just `{centerId}` rather than throwing, so a stale
 * selection (e.g. the previously selected tab was deleted) degrades to an
 * empty-looking local graph instead of crashing the view.
 */
function buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push(edge.target);
    adjacency.get(edge.target)!.push(edge.source);
  }
  return adjacency;
}

/** BFS hop-distance from `centerId` to every node reachable within `depth` hops (`"infinite"` walks the whole connected component). The center itself is distance 0. */
export function computeLocalDistances(
  centerId: string,
  edges: GraphEdge[],
  depth: GraphDepth
): Map<string, number> {
  const maxDepth = depthToNumber(depth);
  const adjacency = buildAdjacency(edges);

  const distances = new Map<string, number>([[centerId, 0]]);
  let frontier = [centerId];
  let hops = 0;

  while (frontier.length > 0 && hops < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, hops + 1);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    hops++;
  }

  return distances;
}

export function computeLocalNodeIds(
  centerId: string,
  edges: GraphEdge[],
  depth: GraphDepth
): Set<string> {
  return new Set(computeLocalDistances(centerId, edges, depth).keys());
}
