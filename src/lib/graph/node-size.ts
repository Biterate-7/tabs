import type { NodeSizeMode } from "./types";

export const BASE_NODE_RADIUS = 5;
export const MAX_NODE_RADIUS = 13;

/**
 * Node radius in world units. Capped so a heavily-connected hub never
 * becomes an absurdly large blob (spec: "Do not make highly connected nodes
 * absurdly large") — growth flattens out well before the cap.
 */
export function computeNodeRadius(
  mode: NodeSizeMode,
  connectionCount: number,
  distanceFromCenter: number | undefined
): number {
  if (mode === "connections") {
    return Math.min(BASE_NODE_RADIUS + Math.min(connectionCount, 12) * 0.6, MAX_NODE_RADIUS);
  }
  if (mode === "relevance") {
    if (distanceFromCenter === undefined) return BASE_NODE_RADIUS;
    const falloff = Math.max(0, 6 - distanceFromCenter * 2.5);
    return Math.min(BASE_NODE_RADIUS + falloff, MAX_NODE_RADIUS);
  }
  return BASE_NODE_RADIUS;
}
